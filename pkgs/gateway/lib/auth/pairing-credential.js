/**
 * The pairing credential: the one password that binds a browser to this machine.
 *
 * The password itself is never written down. What reaches the disk is a scrypt
 * hash and its salt, in `pairing.json` beside the session store, and that file is
 * the only source of truth: nothing seeds it, nothing supplies a fallback, and the
 * operator's copy of the password exists only in their head. There is therefore no
 * plaintext credential anywhere in the system — not in the profile, not in the
 * launch environment, not in a log line.
 *
 * A *missing* file is a state, not a failure: it is what makes the login page offer
 * first-time setup ({@link PairingCredential.set}), and a fresh install has to be
 * able to reach that page. A *corrupt* file still stops the mount instead of being
 * tolerated: a gateway that starts with an unusable credential serves a login page
 * nobody can pass.
 *
 * **The accepted trade-off that goes with the missing-file state.** While
 * `pairing.json` does not exist, the setup form is reachable by anyone who can reach
 * the daemon, and it is deliberately not restricted by source address. That is what
 * lets an install be finished from another machine on the LAN without first editing
 * a profile or logging in over SSH. The cost is the mirror image: after the file is
 * deleted — which is also how the credential is reset — the window is open to the
 * same audience until somebody sets it again. This is the opposite of the usual
 * default, which narrows rather than widens, so it is stated here and in the
 * package README rather than only in the design record.
 *
 * The record carries its own scrypt parameters, so a deployment that was paired
 * with a weaker (or a newer) work factor keeps working: verification uses the
 * numbers in the file and never a default of its own. A credential written here is
 * created with this module's current work factor ({@link DEFAULT_SCRYPT}); what the
 * file already holds is never rewritten.
 *
 * @module @yiln-dsh/dsh-gateway/auth/pairing-credential
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Version of the credential file this module writes and accepts. */
export const PAIRING_CREDENTIAL_VERSION = 1

/**
 * File name inside the auth directory.
 *
 * Not `credentials.json`: that name belongs to the SSH password file, and
 * `$DSH_HOME/.credentials.yaml` belongs to the model API keys. The pairing
 * credential is neither.
 */
export const PAIRING_CREDENTIAL_FILE = 'pairing.json'

/**
 * Shortest credential this module writes.
 *
 * Exported so every flow that asks for a new credential — first-time setup, and the
 * authenticated change flow — enforces the same floor instead of each carrying its
 * own number and drifting.
 */
export const PAIRING_CREDENTIAL_MIN_LENGTH = 12

/** Bytes of salt in a newly written record. */
const SALT_BYTES = 16
/** Work factor for a newly written credential: ~16 MiB and tens of milliseconds per check. */
const DEFAULT_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 })
/** Ceiling on the memory one verification may reserve; also bounds a corrupt record. */
const SCRYPT_MAX_MEM_BYTES = 256 * 1024 * 1024
/** Largest N a record may name. */
const MAX_SCRYPT_N = 2 ** 20
/** Bounds on the remaining parameters, so a corrupt record cannot ask for more. */
const MAX_SCRYPT_R = 32
const MAX_SCRYPT_P = 16
const MIN_KEY_LENGTH = 16
const MAX_KEY_LENGTH = 1024

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 1 && (value & (value - 1)) === 0
}

function isBase64Url(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/u.test(value)
}

/**
 * Why a proposed credential cannot be used, or `undefined` when it can.
 *
 * The return values are the dictionary keys the page and the endpoint report, so the
 * refusal a browser sees and the rule the storage enforces cannot say different
 * things. `undefined` means the value passes this layer's rules; whether the two
 * entries of a form match is the form's own question, not one about the credential.
 *
 * @param value - the submitted new credential.
 * @returns `'empty'`, `'tooShort'`, or `undefined`.
 */
export function pairingCredentialProblem(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return 'empty'
  if (text.length < PAIRING_CREDENTIAL_MIN_LENGTH) return 'tooShort'
  return undefined
}

/**
 * Validate one record read from disk.
 *
 * Everything the record says is checked before it is trusted: the parameters are
 * handed to scrypt, so an unvalidated `N` would be a way to ask this process for
 * an arbitrary amount of memory.
 *
 * @param value - the `credential` member of a parsed file.
 * @returns the record with decoded buffers, or null when it is unusable.
 */
function normalizeCredential(value) {
  if (value === null || typeof value !== 'object') return null
  if (value.kdf !== 'scrypt') return null
  const { N, r, p, keylen } = value
  if (!isPowerOfTwo(N) || N > MAX_SCRYPT_N) return null
  if (!Number.isSafeInteger(r) || r < 1 || r > MAX_SCRYPT_R) return null
  if (!Number.isSafeInteger(p) || p < 1 || p > MAX_SCRYPT_P) return null
  if (!Number.isSafeInteger(keylen) || keylen < MIN_KEY_LENGTH || keylen > MAX_KEY_LENGTH) return null
  if (128 * N * r >= SCRYPT_MAX_MEM_BYTES) return null
  if (!isBase64Url(value.salt) || !isBase64Url(value.hash)) return null
  const salt = Buffer.from(value.salt, 'base64url')
  const hash = Buffer.from(value.hash, 'base64url')
  if (salt.length < 8 || salt.length > 64) return null
  if (hash.length !== keylen) return null
  return {
    kdf: 'scrypt',
    salt,
    hash,
    N,
    r,
    p,
    keylen,
    createdAt: Number.isSafeInteger(value.createdAt) && value.createdAt > 0 ? value.createdAt : 0,
  }
}

/** The on-disk form of one record: buffers back to base64url text. */
function serializeCredential(record) {
  return {
    kdf: record.kdf,
    salt: record.salt.toString('base64url'),
    hash: record.hash.toString('base64url'),
    N: record.N,
    r: record.r,
    p: record.p,
    keylen: record.keylen,
    createdAt: record.createdAt,
  }
}

/**
 * Derive the key for a submitted credential.
 *
 * Callback-based `scrypt` wrapped in an explicit promise: this runs on the request
 * path, both when a credential is verified and when one is first written, and a
 * synchronous derivation there would block the listener for its whole duration.
 */
function derive(submitted, salt, parameters) {
  return new Promise((resolve, reject) => {
    scrypt(
      submitted,
      salt,
      parameters.keylen,
      { N: parameters.N, r: parameters.r, p: parameters.p, maxmem: SCRYPT_MAX_MEM_BYTES },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      },
    )
  })
}

/**
 * The pairing credential, loaded from `pairing.json` at construction.
 *
 * Construction is the startup path. A missing file is not an error: it leaves the
 * store unconfigured, which is the one condition that puts the login page into its
 * first-time setup shape. An unreadable or corrupt file still throws, so the plugin
 * fails to mount rather than serving a login page nobody can pass.
 *
 * The only write this class performs is {@link PairingCredential.set}, called when
 * the setup form is submitted. Nothing seeds the file from configuration or the
 * environment.
 */
export class PairingCredential {
  #directory
  #file
  #record
  #now
  #logger

  /**
   * @param options - where the credential lives.
   * @param options.directory - auth directory; the file is `pairing.json` in it.
   * @param options.now - clock used for a new record's `createdAt`.
   * @param options.logger - diagnostic sink, told when the setup window is open.
   */
  constructor({ directory, now = () => Date.now(), logger } = {}) {
    if (typeof directory !== 'string' || directory === '') throw new Error('pairing credential store directory is required')
    this.#directory = directory
    this.#file = join(directory, PAIRING_CREDENTIAL_FILE)
    this.#now = now
    this.#logger = logger
    if (this.#load()) return
    // Not fatal — the page has a way out now — but it is the one state in which
    // anyone who can reach this port may decide the credential, so it is said out
    // loud at startup rather than discovered on the page.
    this.#logger?.warn?.(
      `daemon: no pairing credential at ${this.#file}; the login page will offer first-time setup, which is not restricted by source address`,
    )
  }

  /** Whether a usable credential is loaded, i.e. whether `pairing.json` exists. */
  get configured() {
    return this.#record !== undefined
  }

  /**
   * Read the credential file.
   *
   * @returns true when a record was loaded, false when the file does not exist.
   */
  #load() {
    let info
    try {
      info = lstatSync(this.#file)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new Error(`daemon: the pairing credential file at ${this.#file} could not be read: ${error.message}`, { cause: error })
    }
    if (!info.isFile()) throw new Error(`daemon: the pairing credential at ${this.#file} is not a regular file`)
    try {
      chmodSync(this.#file, 0o600)
      chmodSync(this.#directory, 0o700)
    } catch (error) {
      throw new Error(`daemon: the pairing credential at ${this.#file} could not be made owner-only: ${error.message}`, { cause: error })
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch (error) {
      throw new Error(`daemon: the pairing credential file at ${this.#file} is corrupt: ${error.message}`, { cause: error })
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== PAIRING_CREDENTIAL_VERSION) {
      throw new Error(
        `daemon: the pairing credential file at ${this.#file} is corrupt: expected version ${PAIRING_CREDENTIAL_VERSION}`,
      )
    }
    const record = normalizeCredential(parsed.credential)
    if (record === null) {
      throw new Error(`daemon: the pairing credential file at ${this.#file} is corrupt: its scrypt record is unusable`)
    }
    this.#record = record
    return true
  }

  /**
   * Set a credential: hash it, write the file, and start verifying against it.
   *
   * This is the write half of the missing-file state. The caller decides *who* may
   * call it — for first-time setup that is anyone who can reach the daemon, which is
   * the trade-off documented at the top of this module — and this method decides how
   * the credential is stored: owner-only, atomically, as a scrypt hash whose
   * parameters travel with the record.
   *
   * The write is atomic (a temporary file in the same directory, then a rename), so
   * a crash cannot leave a half-written record that the next start would reject as
   * corrupt. A failure throws, and the previous state — including the previous
   * record, if any — is left untouched.
   *
   * @param credential - the plaintext new credential; never stored.
   * @returns the write, as a promise; rejects on an unusable value or a failed write.
   */
  async set(credential) {
    const problem = pairingCredentialProblem(credential)
    if (problem !== undefined) {
      throw new Error(`daemon: refusing to set a pairing credential that is ${problem === 'empty' ? 'empty' : `shorter than ${PAIRING_CREDENTIAL_MIN_LENGTH} characters`}`)
    }
    const salt = randomBytes(SALT_BYTES)
    const hash = await derive(credential, salt, DEFAULT_SCRYPT)
    const record = { kdf: 'scrypt', salt, hash, ...DEFAULT_SCRYPT, createdAt: this.#now() }
    this.#persist(record)
    this.#record = record
    this.#logger?.info?.(`daemon: wrote the pairing credential to ${this.#file}`)
  }

  /** Atomically write one record with owner-only permissions. */
  #persist(record) {
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
      chmodSync(this.#directory, 0o700)
      writeFileSync(temporary, `${JSON.stringify({ version: PAIRING_CREDENTIAL_VERSION, credential: serializeCredential(record) })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.#file)
      chmodSync(this.#file, 0o600)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // Best-effort cleanup after an interrupted atomic write.
      }
      throw new Error(`daemon: the pairing credential file at ${this.#file} could not be written: ${error.message}`, { cause: error })
    }
  }

  /**
   * Check a submitted pairing credential against the stored hash.
   *
   * The submitted text is derived whether or not it is empty: returning early on
   * an empty or obviously wrong value would make it measurably cheaper than a near
   * miss, and the same timing difference would tell an attacker whether a guess
   * was close. The comparison is `timingSafeEqual` over two fixed-length keys, with
   * a length guard so a damaged record cannot make it throw.
   *
   * With no credential loaded nothing can match; that branch costs no derivation
   * because there is no hash whose closeness could be measured.
   *
   * @param submitted - the password the browser sent.
   * @returns whether it matches the stored credential.
   */
  async verify(submitted) {
    const record = this.#record
    if (record === undefined) return false
    const derived = await derive(String(submitted ?? ''), record.salt, record)
    return derived.length === record.hash.length && timingSafeEqual(derived, record.hash)
  }
}
