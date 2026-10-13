import assert from 'node:assert/strict'
import { readdir, readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { FEATURES } from '../src/features.js'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value }))
const patches = yaml.load(await readFile(new URL(manifest.dsh.bundle.patch, root), 'utf8'), { schema })
const rows = patches.flatMap((entry) => entry.insert ?? [])
assert.equal(rows.filter((entry) => entry.name === manifest.name).length, 1, 'Exactly one bare Host anchor is required')
assert.equal(new Set(rows.map((entry) => entry.id)).size, rows.length)
for (const feature of FEATURES) {
  const row = rows.find(({ id }) => id === feature.id)
  assert.equal(row?.name, `${manifest.name}/${feature.key}`)
  const target = manifest.exports[`./${feature.key}`]
  await access(new URL(target, root))
  const module = await import(new URL(target, root))
  assert.equal(typeof module.apply, 'function')
  assert.ok(Array.isArray(module.inject))
  // A row that injects fewer services than its module reads leaves
  // `ctx.get(...)` undefined at runtime, which silently drops registrations —
  // this is how the work-journal web route went missing. A row may inject more
  // (it can widen the module's own list), so only missing entries are errors.
  if (Array.isArray(row.inject)) {
    const declared = new Set(row.inject)
    const missing = module.inject.filter((service) => !declared.has(service))
    assert.deepEqual(missing, [], `Loader row "${feature.id}" must inject every service of its module`)
  }
  if (['auth-webserver', 'mentor', 'web-daemon'].includes(feature.key)) assert.ok(module.Config, `Missing Config: ${feature.key}`)
}
const checkDirectory = async (path) => {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), path)
    if (entry.isDirectory()) await checkDirectory(file)
    else if (/\.(?:js|mjs)$/.test(entry.name)) execFileSync(process.execPath, ['--check', fileURLToPath(file)])
  }
}
await checkDirectory(new URL('src/', root))
await checkDirectory(new URL('scripts/', root))
await checkDirectory(new URL('test/', root))
for (const file of ['index.js', 'client.js']) execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))])
console.log(`Checked ${FEATURES.length} Host exports, one anchor, and all JavaScript sources`)
