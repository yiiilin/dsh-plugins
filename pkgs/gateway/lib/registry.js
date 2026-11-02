/**
 * The environment registry.
 *
 * Two kinds of environment are recorded here, and the difference is where its dsh
 * process lives:
 *
 * - `remote` — another machine's dsh, reachable only while its tunnel is up. The record
 *   holds no port, no profile name and no filesystem path: those belong to the edge and
 *   are discovered from it, not configured here. What identifies it is the token: an
 *   edge presenting it *is* that environment. `machineId` only helps a human tell two
 *   similarly named hosts apart, and warns when a machine is enrolled twice.
 * - `local` — a profile this node runs itself, spawned and supervised by the daemon.
 *   Its record carries the `profile` to launch and the loopback `port` it listens on,
 *   and needs no token: it never crosses a tunnel, so nothing has to authenticate it.
 *
 * A missing `kind` reads as `remote`, which is what every record written before local
 * profiles existed means. That keeps an existing `environments.json` valid unchanged.
 *
 * @module @yiln-dsh/dsh-gateway/registry
 */

import { randomBytes } from 'node:crypto'

/**
 * Environment ids appear in URLs, so they are restricted to something safe there.
 *
 * The id is a node identifier, not a name: it is generated once from random bytes and
 * never derived from the label. Deriving it from the label meant renaming a machine
 * changed its URL — and left the old URL answering nothing, with no way back.
 */
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u

/** Bytes behind a generated id. 9 bytes is 72 bits: no collision is reachable. */
const ID_BYTES = 9

/** Ids that would be mistaken for a route of our own. */
export const RESERVED_IDS = new Set([
  'admin', 'api', 'assets', 'main', 'portal', 'tunnel', 'self', 'static', 'auth',
])

/**
 * A profile name becomes an environment id and a directory name, so it is held to the
 * same shape dsh itself accepts: no separators, no relative segments.
 */
export const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

const FIELDS = ['id', 'kind', 'label', 'token', 'hostname', 'machineId', 'lastSeen', 'enabled', 'profile', 'port']

/** The two kinds an environment record may declare. */
export const KINDS = ['local', 'remote']

/**
 * Validate one record.
 *
 * Unknown fields are rejected rather than ignored: a silently dropped field is a
 * configuration that looks applied and is not.
 *
 * @param raw - the stored record.
 * @returns the normalized record.
 */
export function normalizeEnvironment(raw) {
  if (raw === null || typeof raw !== 'object') throw new TypeError('daemon: environment must be an object')
  for (const key of Object.keys(raw)) {
    if (!FIELDS.includes(key)) throw new TypeError(`daemon: unknown environment field ${JSON.stringify(key)}`)
  }
  const id = raw.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`daemon: environment id must match ${ID_PATTERN}, got ${JSON.stringify(id)}`)
  }
  if (RESERVED_IDS.has(id)) throw new TypeError(`daemon: environment id ${JSON.stringify(id)} is reserved`)
  // Absent `kind` is a record from before local profiles existed: it is a remote edge.
  const kind = raw.kind === undefined ? 'remote' : raw.kind
  if (!KINDS.includes(kind)) {
    throw new TypeError(`daemon: environment kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`)
  }
  const environment = {
    id,
    kind,
    label: raw.label === undefined ? id : String(raw.label),
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
  }
  if (kind === 'local') {
    // A local environment is defined by what to launch and where it listens; a token
    // would authenticate a hop that does not exist.
    const profile = raw.profile
    if (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile)) {
      throw new TypeError(
        `daemon: local environment ${JSON.stringify(id)} needs a profile matching ${PROFILE_PATTERN}, got ${JSON.stringify(profile)}`,
      )
    }
    const port = raw.port
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError(`daemon: local environment ${JSON.stringify(id)} needs a port 1-65535, got ${JSON.stringify(port)}`)
    }
    if (raw.token !== undefined) {
      throw new TypeError(`daemon: local environment ${JSON.stringify(id)} must not carry a token`)
    }
    environment.profile = profile
    environment.port = port
  } else {
    const token = raw.token
    if (typeof token !== 'string' || token.length < 32) {
      throw new TypeError('daemon: environment token must be at least 32 characters')
    }
    if (raw.profile !== undefined || raw.port !== undefined) {
      throw new TypeError(`daemon: remote environment ${JSON.stringify(id)} must not carry a profile or port`)
    }
    environment.token = token
  }
  if (raw.hostname !== undefined) environment.hostname = String(raw.hostname)
  if (raw.machineId !== undefined) environment.machineId = String(raw.machineId)
  if (raw.lastSeen !== undefined) environment.lastSeen = Number(raw.lastSeen)
  return environment
}

/**
 * Validate a whole registry.
 *
 * @param value - parsed JSON, or undefined when the file is absent.
 * @returns the environments.
 */
export function parseRegistry(value) {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object' || !Array.isArray(value.environments)) {
    throw new TypeError('daemon: registry must be an object with an "environments" array')
  }
  const environments = value.environments.map(normalizeEnvironment)
  const seen = new Set()
  const tokens = new Map()
  const ports = new Map()
  const profiles = new Map()
  for (const environment of environments) {
    if (seen.has(environment.id)) {
      throw new TypeError(`daemon: duplicate environment id ${JSON.stringify(environment.id)}`)
    }
    seen.add(environment.id)
    if (environment.kind === 'local') {
      // Two local environments on one port would proxy to whichever bound first; two
      // naming one profile would spawn it twice and split one session registry.
      const portOwner = ports.get(environment.port)
      if (portOwner !== undefined) {
        throw new TypeError(
          `daemon: local environments ${JSON.stringify(portOwner)} and ${JSON.stringify(environment.id)} share port ${environment.port}`,
        )
      }
      ports.set(environment.port, environment.id)
      const profileOwner = profiles.get(environment.profile)
      if (profileOwner !== undefined) {
        throw new TypeError(
          `daemon: local environments ${JSON.stringify(profileOwner)} and ${JSON.stringify(environment.id)} both run profile ${JSON.stringify(environment.profile)}`,
        )
      }
      profiles.set(environment.profile, environment.id)
      continue
    }
    // One token, one environment: sharing would make an edge's identity depend on
    // insertion order.
    const owner = tokens.get(environment.token)
    if (owner !== undefined) {
      throw new TypeError(
        `daemon: environments ${JSON.stringify(owner)} and ${JSON.stringify(environment.id)} share a token`,
      )
    }
    tokens.set(environment.token, environment.id)
  }
  return environments
}

/** Serialize for storage. The file holds tokens, so it is written 0600. */
export function serializeRegistry(environments) {
  return `${JSON.stringify({ environments }, null, 2)}\n`
}

/**
 * Generate an environment id from what the operator typed.
 *
 * @param wanted - a label or host the operator supplied.
 * @param taken - ids already in use.
 * @returns a unique, URL-safe id.
 */
export function deriveId(taken) {
  // base64url yields `-` and `_`; only `-` is safe in a path segment, so the alphabet is
  // narrowed to lowercase hex-ish letters and digits.
  for (;;) {
    const raw = randomBytes(ID_BYTES).toString('hex').slice(0, 16)
    const candidate = `n${raw}`
    if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate
  }
}

/**
 * The id this function used to produce, kept only so an existing registry can be read.
 *
 * @deprecated Nothing creates ids this way any more; see {@link deriveId}.
 */
export function deriveLegacyId(wanted, taken) {
  const base = String(wanted)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 28)
  const seed = /^[a-z]/u.test(base) ? base : `env-${base}`
  // Trailing separators are noise in a URL and would survive into the id.
  const start = seed.replace(/-+$/u, '') === '' ? 'env' : seed.replace(/-+$/u, '')
  if (!taken.has(start) && !RESERVED_IDS.has(start)) return start
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${start}-${n}`
    if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate
  }
  throw new Error('daemon: could not derive a free environment id')
}

/** A token with enough entropy that guessing is not a strategy. */
export function freshToken() {
  return randomBytes(32).toString('base64url')
}
