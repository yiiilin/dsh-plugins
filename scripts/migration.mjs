import assert from 'node:assert/strict'
import { isMap, isSeq, parseDocument } from 'yaml'

const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

/**
 * Legacy module addresses per Loader row id, and the standalone package each one
 * became once the suite split into pkgs/.
 *
 * This table is a deliberate snapshot, not a derivation: it exists to rewrite
 * profiles written against the old aggregate package, so it must keep naming the
 * addresses that are no longer published. Adding a plugin to the workspace does
 * not add a row here.
 */
export const ADDRESSES = Object.freeze([
  { id: 'webserver-auth', key: 'auth-webserver', legacy: '@yiln-dsh/dsh-plugin-auth-webserver' },
  { id: 'dsh-delete-session', key: 'delete-session', legacy: '@yiln-dsh/dsh-plugin-delete-session' },
  { id: 'dsh-git-graph', key: 'git-graph', legacy: '@yiln-dsh/dsh-plugin-git-graph' },
  { id: 'session-list-cache', key: 'session-list-cache', legacy: '@yiln-dsh/dsh-plugin-session-list-cache' },
  { id: 'web-daemon', key: 'web-daemon', legacy: '@yiln-dsh/dsh-plugin-web-daemon' },
  { id: 'session-mode', key: 'session-mode', legacy: '@yiln-dsh/dsh-plugins/session-mode' },
  { id: 'tool-restrict-presets', key: 'tool-restrict-presets', legacy: '@yiln-dsh/dsh-plugins/tool-restrict-presets' },
  { id: 'dsh-desktop-vnc', key: 'desktop-vnc', legacy: '@yiln-dsh/dsh-plugin-desktop-vnc' },
  { id: 'fleet', key: 'fleet', legacy: '@yiln-dsh/dsh-plugins/fleet' },
])

/** The standalone package name a feature directory became. */
const targetOf = (key) => `@yiln-dsh/dsh-${key}`

/**
 * Every address that used to resolve to one feature: the legacy name plus the
 * aggregate-package subpath the suite used before the split.
 */
const sourcesOf = ({ key, legacy }) => new Set([legacy, `@yiln-dsh/dsh-plugins/${key}`])

/**
 * Rewrite Loader module addresses in one profile patch.
 *
 * Only `name` values on rows whose `id` matches a known feature are touched, and
 * every other byte — comments, `!!js` tags, ordering — survives. A row already
 * naming its standalone package is left alone, so the migration is idempotent.
 *
 * @param source - the profile patch text.
 * @param packageName - reserved for callers that passed the old aggregate name.
 * @returns the possibly rewritten text plus the applied changes.
 */
export function migrateProfilePatch(source, packageName = '@yiln-dsh/dsh-plugins') {
  if (typeof source !== 'string') throw new TypeError('Profile patch must be text')
  const document = parseDocument(source, options)
  if (document.errors.length) throw new TypeError('Profile patch is invalid YAML')
  if (!isSeq(document.contents)) throw new TypeError('Profile patch must be an entry list')
  const before = document.toJS({ maxAliasCount: 100 })
  const changes = []
  const visit = (sequence) => {
    if (!isSeq(sequence)) return
    for (const entry of sequence.items) {
      if (!isMap(entry)) continue
      const record = ADDRESSES.find((candidate) => entry.get('id') === candidate.id)
      if (record !== undefined) {
        const current = entry.get('name')
        if (sourcesOf(record).has(current)) {
          const to = targetOf(record.key)
          entry.set('name', to)
          changes.push({ id: record.id, from: current, to })
        }
      }
      visit(entry.get('insert', true))
      if (entry.get('group') === true) visit(entry.get('config', true))
    }
  }
  visit(document.contents)
  if (!changes.length) return { content: source, changes }

  // Prove nothing but the rewritten module addresses moved.
  const after = document.toJS({ maxAliasCount: 100 })
  const normalize = (entries) => entries.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const copy = { ...entry }
    const record = ADDRESSES.find((candidate) => copy.id === candidate.id)
    // Normalize every address a row could legitimately carry to its legacy
    // spelling, so the before/after comparison ignores which alias was written.
    if (record !== undefined && (targetOf(record.key) === copy.name || sourcesOf(record).has(copy.name))) {
      copy.name = record.legacy
    }
    if (Array.isArray(copy.insert)) copy.insert = normalize(copy.insert)
    if (copy.group === true && Array.isArray(copy.config)) copy.config = normalize(copy.config)
    return copy
  })
  assert.deepEqual(normalize(after), normalize(before), 'Migration changed non-module configuration values')
  return { content: document.toString(), changes }
}
