import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a row naming no legacy module stays untouched', async () => {
  const { migrateProfilePatch } = await migration()
  // A retired package's old row is no longer a migration target: rewriting it would
  // point the profile at a package that no longer exists, so it is left as written.
  const source = '- id: delegate-mode\n  config:\n    defaultMode: delegate-writes\n'
  assert.deepEqual(migrateProfilePatch(source), { content: source, changes: [] })
})

const migration = () => import('../scripts/migration.mjs')

test('migration replaces only known Loader module names and preserves config tags/comments', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '# keep deployment comment\n- id: web-daemon\n  name: "@yiln-dsh/dsh-plugin-web-daemon" # keep name comment\n  config:\n    enabled: true\n    command: !!js ctx.webStartup.port\n- id: llm-pi-ai\n  config:\n    providers:\n      fake:\n        name: "@yiln-dsh/dsh-plugin-web-daemon"\n- id: webserver-auth\n  config:\n    port: 3095\n'
  const result = migrateProfilePatch(source)
  assert.deepEqual(result.changes, [{ id: 'web-daemon', from: '@yiln-dsh/dsh-plugin-web-daemon', to: '@yiln-dsh/dsh-web-daemon' }])
  assert.ok(result.content.includes('# keep deployment comment'))
  assert.ok(result.content.includes('# keep name comment'))
  assert.ok(result.content.includes('!!js ctx.webStartup.port'))
  assert.ok(result.content.includes('name: "@yiln-dsh/dsh-plugin-web-daemon"'))
  assert.equal(migrateProfilePatch(result.content).content, result.content)
  assert.deepEqual(migrateProfilePatch(result.content).changes, [])
})

test('migration leaves already compatible patches byte-for-byte unchanged', async () => {
  const { migrateProfilePatch } = await migration()
  // The standalone package name is the only already-compatible spelling; both
  // the legacy name and the aggregate subpath are rewritten.
  const source = '# untouched\n- id: web-daemon\n  name: "@yiln-dsh/dsh-web-daemon"\n'
  assert.deepEqual(migrateProfilePatch(source), { content: source, changes: [] })
})

test('migration rewrites the retired aggregate subpath too', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '- id: web-daemon\n  name: "@yiln-dsh/dsh-plugins/web-daemon"\n'
  assert.deepEqual(migrateProfilePatch(source).changes, [
    { id: 'web-daemon', from: '@yiln-dsh/dsh-plugins/web-daemon', to: '@yiln-dsh/dsh-web-daemon' },
  ])
})

test('migration rejects malformed or non-list patches without evaluating !!js', async () => {
  const { migrateProfilePatch } = await migration()
  assert.throws(() => migrateProfilePatch('- id: [\n'))
  assert.throws(() => migrateProfilePatch('models: {}\n'))
  const source = '- id: dsh-git-graph\n  name: "@yiln-dsh/dsh-plugin-git-graph"\n  config:\n    expression: !!js process.exit(99)\n'
  const result = migrateProfilePatch(source)
  assert.ok(result.content.includes('!!js process.exit(99)'))
})

test('migration handles inserted and grouped entries without walking model dictionaries', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '- insert:\n    - id: dsh-git-graph\n      name: "@yiln-dsh/dsh-plugin-git-graph"\n- id: features\n  group: true\n  config:\n    - id: web-daemon\n      name: "@yiln-dsh/dsh-plugin-web-daemon"\n'
  assert.deepEqual(migrateProfilePatch(source).changes.map(({ id }) => id), ['dsh-git-graph', 'web-daemon'])
})
