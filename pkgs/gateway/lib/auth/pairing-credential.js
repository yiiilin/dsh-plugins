/**
 * The pairing credential: the one password that binds a browser to this machine.
 *
 * The password itself is never written down. What reaches the disk is a scrypt
 * hash and its salt, in `pairing.json` beside the session and passkey stores:
 * the first start hashes the configured password and writes the file, and every
 * start after that reads the file alone. A configured password is therefore a
 * seed, not a login fallback — leaving `DSH_AUTH_PASS` in the environment does
 * not keep a plaintext copy alive on disk, and a corrupt file stops the mount
 * instead of being tolerated.
 *
 * The record carries its own scrypt parameters, so a deployment that was paired
 * with a weaker (or a newer) work factor keeps working: verification uses the
 * numbers in the file, never the defaults in this module.
 *
 * @module @yiln-dsh/dsh-gateway/auth/pairing-credential
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
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

/** Bytes of salt in a bootstrapped record. */
const SALT_BYTES = 16
/** Work factor for a newly bootstrapped credential: ~16 MiB and ~30-100 ms per check. */
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
 * path, and a synchronous derivation there would block the listener for its whole
 * duration. `scryptSync` is used only once, when the file is first written.
 */
function derive(submitted, record) {
  return new Promise((resolve, reject) => {
    scrypt(
      submitted,
      record.salt,
      record.keylen,
      { N: record.N, r: record.r, p: record.p, maxmem: SCRYPT_MAX_MEM_BYTES },
      (error, key) => {
        if (error) reject(error)
        else resolve(key)
      },
    )
  })
}

/**
 * Owner-only pairing credential, loaded from `pairing.json` at construction.
 *
 * Construction is the startup path: a missing file with no password, an
 * unreadable file and a corrupt file all throw here, so the plugin fails to mount
 * rather than serving a login page nobody can pass.
 */
export class PairingCredential {
  #directory
  #file
  #record
  #now
  #logger

  /**
   * @param options - where the credential lives and what may seed it.
   * @param options.directory - auth directory; the file is `pairing.json` in it.
   * @param options.password - seed for a missing file. Ignored once the file exists.
   * @param options.now - clock used for the record's `createdAt`.
   * @param options.logger - diagnostic sink.
   */
  constructor({ directory, password = '', now = () => Date.now(), logger } = {}) {
    if (typeof directory !== 'string' || directory === '') throw new Error('pairing credential store directory is required')
    this.#directory = directory
    this.#file = join(directory, PAIRING_CREDENTIAL_FILE)
    this.#now = now
    this.#logger = logger
    if (this.#load()) return
    if (typeof password !== 'string' || password === '') {
      throw new Error(
        `daemon: the pairing credential file is missing at ${this.#file} and no password is configured (config.password or DSH_AUTH_PASS) to create it`,
      )
    }
    this.#bootstrap(password)
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

  /** Hash a configured password once and write the credential file. */
  #bootstrap(password) {
    const salt = randomBytes(SALT_BYTES)
    const hash = scryptSync(password, salt, DEFAULT_SCRYPT.keylen, { ...DEFAULT_SCRYPT, maxmem: SCRYPT_MAX_MEM_BYTES })
    this.#record = { kdf: 'scrypt', salt, hash, ...DEFAULT_SCRYPT, createdAt: this.#now() }
    this.#persist()
    this.#logger?.info?.(`daemon: wrote the pairing credential to ${this.#file}`)
  }

  /** Atomically write the credential file with owner-only permissions. */
  #persist() {
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 })
      chmodSync(this.#directory, 0o700)
      writeFileSync(temporary, `${JSON.stringify({ version: PAIRING_CREDENTIAL_VERSION, credential: serializeCredential(this.#record) })}\n`, {
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
   * @param submitted - the password the browser sent.
   * @returns whether it matches the stored credential.
   */
  async verify(submitted) {
    const record = this.#record
    const derived = await derive(String(submitted ?? ''), record)
    return derived.length === record.hash.length && timingSafeEqual(derived, record.hash)
  }
}
