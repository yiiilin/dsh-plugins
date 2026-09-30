import assert from 'node:assert/strict'
import { isMap, isSeq, parseDocument } from 'yaml'
import { FEATURES } from './features.js'

const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }] }

/** Rewrite Loader module addresses only; never evaluate config expressions. */
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
      const feature = FEATURES.find(({ id, legacy }) => legacy !== undefined && entry.get('id') === id && entry.get('name') === legacy)
      if (feature) {
        const to = `${packageName}/${feature.key}`
        entry.set('name', to)
        changes.push({ id: feature.id, from: feature.legacy, to })
      }
      visit(entry.get('insert', true))
      if (entry.get('group') === true) visit(entry.get('config', true))
    }
  }
  visit(document.contents)
  if (!changes.length) return { content: source, changes }
  const after = document.toJS({ maxAliasCount: 100 })
  const normalize = (entries) => entries.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const copy = { ...entry }
    const feature = FEATURES.find(({ id }) => copy.id === id)
    if (feature && [feature.legacy, `${packageName}/${feature.key}`].includes(copy.name)) copy.name = feature.legacy
    if (Array.isArray(copy.insert)) copy.insert = normalize(copy.insert)
    if (copy.group === true && Array.isArray(copy.config)) copy.config = normalize(copy.config)
    return copy
  })
  assert.deepEqual(normalize(after), normalize(before), 'Migration changed non-module configuration values')
  return { content: document.toString(), changes }
}
