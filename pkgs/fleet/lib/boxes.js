/**
 * Fleet box registry: the durable list of remote development boxes.
 *
 * One *box* is one development target. It owns a profile directory, a TCP port
 * on the fleet host, and — for an SSH box — the OpenSSH alias plus the remote
 * helper installation. The registry is plain JSON so an operator can read or
 * hand-edit it, and so a fleet host restart never depends on a database.
 *
 * The registry is deliberately store-agnostic: {@link parseRegistry} validates
 * untrusted JSON, and the manager owns reading and writing the file.
 *
 * @module @yiln-dsh/dsh-fleet/boxes
 */

/** Box ids address a URL prefix, a profile directory, and a port range. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/

/**
 * Normalize a raw box record and reject one the gateway could not serve.
 *
 * The function is intentionally strict: an unknown key is a typo that would
 * otherwise be silently dropped from a file an operator hand-edits.
 *
 * @param raw - one registry entry from untrusted JSON.
 * @returns the normalized box.
 * @throws {TypeError} when a field is missing, out of range, or unknown.
 */
export function normalizeBox(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('fleet: a box must be an object')
  }
  const known = new Set([
    'id',
    'label',
    'kind',
    'profile',
    'port',
    'sshHost',
    'sshNode',
    'sshHelper',
    'sshHelperHash',
    'workspace',
    'enabled',
  ])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new TypeError(`fleet: box has unknown field "${key}"`)
  }
  const id = requireString(raw, 'id')
  if (!ID_PATTERN.test(id)) {
    throw new TypeError(`fleet: box id ${JSON.stringify(id)} must match ${ID_PATTERN}`)
  }
  const kind = raw.kind ?? 'local'
  if (kind !== 'local' && kind !== 'ssh') {
    throw new TypeError(`fleet: box ${id} kind must be "local" or "ssh"`)
  }
  const port = requirePort(raw, id)
  const workspace = requireAbsolute(raw, 'workspace', id)
  const box = {
    id,
    label: raw.label === undefined ? id : requireString(raw, 'label'),
    kind,
    profile: raw.profile === undefined ? `fleet-${id}` : requireString(raw, 'profile'),
    port,
    workspace,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
  }
  if (kind === 'ssh') {
    box.sshHost = requireString(raw, 'sshHost')
    box.sshNode = requireAbsolute(raw, 'sshNode', id)
    box.sshHelper = requireAbsolute(raw, 'sshHelper', id)
    box.sshHelperHash = requireHash(raw, 'sshHelperHash', id)
  }
  return box
}

/**
 * Validate a whole registry document.
 *
 * Ports and ids must both be unique: two boxes sharing a port would race for
 * the listener, and two sharing an id would race for the URL prefix.
 *
 * @param raw - parsed JSON from the registry file.
 * @returns the normalized box list, preserving file order.
 * @throws {TypeError} when the document or any entry is invalid.
 */
export function parseRegistry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('fleet: registry must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'boxes') {
      throw new TypeError(`fleet: registry has unknown field "${key}"`)
    }
  }
  if (raw.version !== 1) throw new TypeError('fleet: registry version must be 1')
  if (!Array.isArray(raw.boxes)) throw new TypeError('fleet: registry boxes must be an array')
  const boxes = raw.boxes.map(normalizeBox)
  const seenId = new Set()
  const seenPort = new Set()
  for (const box of boxes) {
    if (seenId.has(box.id)) throw new TypeError(`fleet: duplicate box id "${box.id}"`)
    seenId.add(box.id)
    if (seenPort.has(box.port)) throw new TypeError(`fleet: duplicate box port ${box.port}`)
    seenPort.add(box.port)
  }
  return boxes
}

/** The document the manager writes back after a mutation. */
export function serializeRegistry(boxes) {
  return { version: 1, boxes }
}

/**
 * Pick a free port for a new box.
 *
 * The candidate range is bounded so an operator can firewall it as one block,
 * and `taken` keeps an allocation from colliding with an existing box.
 *
 * @param taken - ports already assigned to a box.
 * @param base - first candidate port.
 * @param span - how many ports to try.
 * @returns the first free port.
 * @throws {Error} when the range is exhausted.
 */
export function allocatePort(taken, base = 3101, span = 200) {
  const used = new Set(taken)
  for (let port = base; port < base + span; port += 1) {
    if (!used.has(port)) return port
  }
  throw new Error(`fleet: no free port in ${base}..${base + span - 1}`)
}

function requireString(raw, key) {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`fleet: box field "${key}" must be a non-empty string`)
  }
  return value
}

function requireAbsolute(raw, key, id) {
  const value = requireString(raw, key)
  if (!value.startsWith('/')) {
    throw new TypeError(`fleet: box ${id} field "${key}" must be an absolute path`)
  }
  return value
}

function requireHash(raw, key, id) {
  const value = requireString(raw, key)
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`fleet: box ${id} field "${key}" must be a lowercase SHA-256`)
  }
  return value
}

function requirePort(raw, id) {
  const value = raw.port
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new TypeError(`fleet: box ${id} port must be an integer in 1024..65535`)
  }
  return value
}
