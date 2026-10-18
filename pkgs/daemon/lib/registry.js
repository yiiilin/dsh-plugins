/**
 * Profile registry: the durable list of development profiles this daemon runs.
 *
 * One *profile* is one development target. It owns a profile directory, a
 * loopback TCP port on this host, and — for an SSH profile — the connection
 * coordinates plus the remote helper installation. Everything is plain JSON so
 * an operator can read or hand-edit it, and a daemon restart never depends on a
 * database.
 *
 * The module is deliberately store-agnostic: {@link normalizeProfile} validates
 * untrusted JSON, and the manager owns reading and writing the file.
 *
 * @module @yiln-dsh/dsh-daemon/registry
 */

/** Profile ids address a URL prefix, a profile directory, and a port. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/u

/**
 * Prefixes the daemon serves itself, so a profile may not claim one.
 *
 * A collision would make a profile unreachable behind the daemon's own routes,
 * so these are refused at registration rather than debugged later.
 */
export const RESERVED_IDS = new Set([
  'admin',
  'api',
  'assets',
  'connect',
  'devtools',
  'favicon.ico',
  'index.html',
  'plugins',
  'settings',
])

/** Fields every profile carries. */
const COMMON_FIELDS = ['id', 'label', 'kind', 'profile', 'port', 'workspace', 'enabled']

/** Fields only an SSH profile carries. */
const SSH_FIELDS = ['sshHost', 'sshPort', 'sshUser', 'sshNode', 'sshHelper', 'sshHelperHash']

/**
 * Normalize a raw profile record and reject one the daemon could not serve.
 *
 * Strict on purpose: an unknown key is a typo that would otherwise be silently
 * dropped from a file an operator hand-edits.
 *
 * @param raw - one registry entry from untrusted JSON.
 * @returns the normalized profile.
 * @throws {TypeError} when a field is missing, out of range, or unknown.
 */
export function normalizeProfile(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('daemon: a profile must be an object')
  }
  const known = new Set([...COMMON_FIELDS, ...SSH_FIELDS])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new TypeError(`daemon: profile has unknown field ${JSON.stringify(key)}`)
  }

  const id = requireString(raw, 'id')
  if (!ID_PATTERN.test(id)) {
    throw new TypeError(`daemon: profile id ${JSON.stringify(id)} must match ${String(ID_PATTERN)}`)
  }
  if (RESERVED_IDS.has(id)) {
    throw new TypeError(`daemon: profile id ${JSON.stringify(id)} is reserved by the daemon`)
  }

  const kind = raw.kind ?? 'local'
  if (kind !== 'local' && kind !== 'ssh') {
    throw new TypeError(`daemon: profile kind must be "local" or "ssh", got ${JSON.stringify(kind)}`)
  }

  const profile = {
    id,
    label: raw.label === undefined ? id : requireString(raw, 'label'),
    kind,
    profile: raw.profile === undefined ? `daemon-${id}` : requireString(raw, 'profile'),
    port: requirePort(raw, 'port'),
    workspace: requireAbsolutePath(raw, 'workspace'),
    enabled: raw.enabled === undefined ? true : requireBoolean(raw, 'enabled'),
  }

  if (kind === 'ssh') {
    profile.sshHost = requireString(raw, 'sshHost')
    if (raw.sshPort !== undefined) profile.sshPort = requirePort(raw, 'sshPort')
    profile.sshUser = requireString(raw, 'sshUser')
    const node = optionalAbsolutePath(raw, 'sshNode')
    if (node !== undefined) profile.sshNode = node
    profile.sshHelper = requireAbsolutePath(raw, 'sshHelper')
    profile.sshHelperHash = requireHash(raw, 'sshHelperHash')
  }

  return profile
}

/**
 * Validate an untrusted registry document.
 *
 * @param parsed - the decoded JSON value.
 * @returns the profile list, empty when the document is empty.
 * @throws {TypeError} when the document is not a `{ profiles: [...] }` object.
 */
export function parseRegistry(parsed) {
  if (parsed === null || parsed === undefined) return []
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('daemon: registry must be an object')
  }
  const profiles = parsed.profiles
  if (profiles === undefined) return []
  if (!Array.isArray(profiles)) throw new TypeError('daemon: registry "profiles" must be an array')
  const normalized = profiles.map(normalizeProfile)
  const seen = new Set()
  for (const profile of normalized) {
    if (seen.has(profile.id)) throw new TypeError(`daemon: duplicate profile id ${JSON.stringify(profile.id)}`)
    seen.add(profile.id)
  }
  return normalized
}

/**
 * Serialize profiles for storage.
 *
 * @param profiles - the normalized profiles.
 * @returns the JSON-safe document.
 */
export function serializeRegistry(profiles) {
  return { profiles: profiles.map((profile) => ({ ...profile })) }
}

/**
 * Pick the lowest free port at or above the base.
 *
 * Allocating from a fixed base keeps ports recognizable and stable in a
 * firewall rule; a used port is skipped rather than reassigned.
 *
 * @param base - the first candidate port.
 * @param used - ports already taken by the registry.
 * @param isFree - predicate that also rejects a port the OS reports as bound.
 * @returns the chosen port.
 * @throws {Error} when every candidate up to the ceiling is taken.
 */
export function allocatePort(base, used, isFree = () => true) {
  const ceiling = Math.min(base + 500, 65535)
  for (let port = base; port <= ceiling; port += 1) {
    if (used.has(port)) continue
    if (!isFree(port)) continue
    return port
  }
  throw new Error(`daemon: no free port in ${base}..${ceiling}`)
}

/**
 * Derive a usable profile id from a host name or a user-supplied label.
 *
 * The daemon owns id allocation, so a cosmetic name must not surface as an
 * error: invalid characters are dropped and a reserved or taken id is suffixed
 * until it is usable.
 *
 * @param wanted - the requested name, possibly empty or badly shaped.
 * @param taken - ids already in use, including the reserved set.
 * @returns an id that passes {@link normalizeProfile}.
 */
export function deriveId(wanted, taken) {
  const base = String(wanted ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 24)
  // An empty or purely symbolic name has nothing to derive from; fall back to a
  // stable noun rather than emitting a one-letter id.
  const seed = base === '' ? 'profile' : /^[a-z]/u.test(base) ? base : `p-${base}`
  const candidate = seed
  if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${candidate}-${suffix}`.slice(0, 32)
    if (!taken.has(next) && !RESERVED_IDS.has(next)) return next
  }
  throw new Error(`daemon: cannot derive an unused id from ${JSON.stringify(wanted)}`)
}

function requireString(raw, key) {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`daemon: profile field ${JSON.stringify(key)} must be a non-empty string`)
  }
  return value
}

function requireBoolean(raw, key) {
  const value = raw[key]
  if (typeof value !== 'boolean') {
    throw new TypeError(`daemon: profile field ${JSON.stringify(key)} must be a boolean`)
  }
  return value
}

function requirePort(raw, key) {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`daemon: profile field ${JSON.stringify(key)} must be a port number`)
  }
  return value
}

function requireAbsolutePath(raw, key) {
  const value = requireString(raw, key)
  if (!value.startsWith('/')) {
    throw new TypeError(`daemon: profile field ${JSON.stringify(key)} must be an absolute path`)
  }
  return value
}

function optionalAbsolutePath(raw, key) {
  if (raw[key] === undefined) return undefined
  return requireAbsolutePath(raw, key)
}

function requireHash(raw, key) {
  const value = requireString(raw, key)
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`daemon: profile field ${JSON.stringify(key)} must be a lowercase SHA-256`)
  }
  return value
}
