import assert from 'node:assert/strict'
import { test } from 'node:test'

test('new feature overrides without legacy module names remain unchanged', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '- id: session-mode\n  config:\n    defaultMode: delegate-writes\n'
  assert.deepEqual(migrateProfilePatch(source), { content: source, changes: [] })
})

const migration = () => import('../src/migration.js')

test('migration replaces only known Loader module names and preserves config tags/comments', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '# keep deployment comment\n- id: web-daemon\n  name: "@yiln-dsh/dsh-plugin-web-daemon" # keep name comment\n  config:\n    enabled: true\n    command: !!js ctx.webStartup.port\n- id: llm-pi-ai\n  config:\n    providers:\n      fake:\n        name: "@yiln-dsh/dsh-plugin-web-daemon"\n- id: webserver-auth\n  config:\n    port: 3095\n'
  const result = migrateProfilePatch(source)
  assert.deepEqual(result.changes, [{ id: 'web-daemon', from: '@yiln-dsh/dsh-plugin-web-daemon', to: '@yiln-dsh/dsh-plugins/web-daemon' }])
  assert.ok(result.content.includes('# keep deployment comment'))
  assert.ok(result.content.includes('# keep name comment'))
  assert.ok(result.content.includes('!!js ctx.webStartup.port'))
  assert.ok(result.content.includes('name: "@yiln-dsh/dsh-plugin-web-daemon"'))
  assert.equal(migrateProfilePatch(result.content).content, result.content)
  assert.deepEqual(migrateProfilePatch(result.content).changes, [])
})

test('migration leaves already compatible patches byte-for-byte unchanged', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '# untouched\n- id: web-daemon\n  name: "@yiln-dsh/dsh-plugins/web-daemon"\n'
  assert.deepEqual(migrateProfilePatch(source), { content: source, changes: [] })
})

test('migration rejects malformed or non-list patches without evaluating !!js', async () => {
  const { migrateProfilePatch } = await migration()
  assert.throws(() => migrateProfilePatch('- id: [\n'))
  assert.throws(() => migrateProfilePatch('models: {}\n'))
  const source = '- id: dsh-mentor\n  name: "@yiln-dsh/dsh-plugin-mentor"\n  config:\n    expression: !!js process.exit(99)\n'
  const result = migrateProfilePatch(source)
  assert.ok(result.content.includes('!!js process.exit(99)'))
})

test('migration handles inserted and grouped entries without walking model dictionaries', async () => {
  const { migrateProfilePatch } = await migration()
  const source = '- insert:\n    - id: dsh-mentor\n      name: "@yiln-dsh/dsh-plugin-mentor"\n- id: features\n  group: true\n  config:\n    - id: web-daemon\n      name: "@yiln-dsh/dsh-plugin-web-daemon"\n'
  assert.deepEqual(migrateProfilePatch(source).changes.map(({ id }) => id), ['dsh-mentor', 'web-daemon'])
})
