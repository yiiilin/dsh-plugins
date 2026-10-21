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
 * A corrupt file stops the mount instead of being tolerated: a gateway that starts
 * with an unusable credential serves a login page nobody can pass.
 *
 * The record carries its own scrypt parameters, so a deployment that was paired
 * with a weaker (or a newer) work factor keeps working: verification uses the
 * numbers in the file and never a default of its own. That is also why this class
 * has no write path — it reads and verifies, and whatever creates a credential
 * decides the parameters it is created with.
 *
 * @module @yiln-dsh/dsh-gateway/auth/pairing-credential
 */

import { scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync } from 'node:fs'
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

/**
 * Derive the key for a submitted credential.
 *
 * Callback-based `scrypt` wrapped in an explicit promise: this runs on the request
 * path, and a synchronous derivation there would block the listener for its whole
 * duration.
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
 * Construction is the startup path: a missing file, an unreadable file and a
 * corrupt file all throw here, so the plugin fails to mount rather than serving a
 * login page nobody can pass. Nothing seeds the file: the credential is written by
 * whatever creates it, and this class only ever reads it back.
 */
export class PairingCredential {
  #directory
  #file
  #record

  /**
   * @param options - where the credential lives.
   * @param options.directory - auth directory; the file is `pairing.json` in it.
   */
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || directory === '') throw new Error('pairing credential store directory is required')
    this.#directory = directory
    this.#file = join(directory, PAIRING_CREDENTIAL_FILE)
    if (!this.#load()) {
      throw new Error(
        `daemon: the pairing credential file is missing at ${this.#file}; the credential comes from that file alone and is never seeded from configuration or the environment`,
      )
    }
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
