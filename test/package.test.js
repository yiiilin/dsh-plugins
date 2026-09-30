import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const ROOT = new URL('../', import.meta.url)
const FEATURES = ['auth-webserver', 'delete-session', 'git-graph', 'mentor', 'session-list-cache', 'web-daemon', 'session-mode']
const read = (path) => readFile(new URL(path, ROOT), 'utf8')

test('workspace root is the only installable suite package', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.name, '@yiln-dsh/dsh-plugins')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'], './client.js')
  for (const feature of FEATURES) {
    assert.equal(pkg.exports[`./${feature}`], `./src/${feature}/index.js`)
    await access(new URL(`src/${feature}/index.js`, ROOT))
    await assert.rejects(() => access(new URL(`src/${feature}/package.json`, ROOT)))
  }
  assert.ok(Object.keys(pkg.dependencies).every((name) => !name.startsWith('@yiln-dsh/dsh-plugin-')))
})

test('single browser entry registers all six client modules under child lifetimes', async () => {
  const styles = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ setAttribute(name, value) { this[name] = value }, remove() { this.removed = true } }),
    querySelectorAll: () => styles.filter((style) => !style.removed && style['data-plugin'] === '@yiln-dsh/dsh-plugins'),
    head: { append(style) { styles.push(style) } },
  }
  const entries = []
  const window = { __ModuleLoader__: { load(entry) { entries.push(entry) } } }
  vm.runInNewContext(await read('client.js'), { window, document, console })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, '@yiln-dsh/dsh-plugins')
  const ui = new Proxy({}, { get: () => () => null })
  const exports = entries[0].factory((name) => {
    if (name === 'react') return ui
    if (name === 'react-dom') return { createPortal() {} }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return ui
    throw new Error(`Unexpected client dependency: ${name}`)
  })
  const modules = [], disposers = []
  assert.ok(exports.inject.includes('timer'))
  await exports.apply({ plugin(module) { modules.push(module) }, effect(factory) { disposers.push(factory()) } })
  assert.equal(modules.length, 6)
  assert.equal(new Set(modules.map((module) => module.name)).size, 6)
  assert.ok(modules.every((module) => typeof module.apply === 'function' && Array.isArray(module.inject)))
  assert.ok(styles.every((style) => style['data-plugin'] === '@yiln-dsh/dsh-plugins'))
  for (const dispose of disposers.reverse()) dispose()
  assert.ok(styles.every((style) => style.removed))
})
