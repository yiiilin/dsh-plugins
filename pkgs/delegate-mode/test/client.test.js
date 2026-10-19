import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function load(document) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entry
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { entry = value } } }, AbortController, ...(document ? { document } : {}) })
  return entry.factory((name) => {
    assert.equal(name, 'react')
    return { createElement: (type, props, ...children) => ({ type, props, children }), useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }), useEffect() {} }
  })
}

test('delegate toggle registers matching locale keys beside the permission control', async () => {
  const client = await load(), locales = [], slots = []
  client.apply({
    locale: { register(ns, dictionaries) { locales.push({ ns, dictionaries }); return () => {} }, bind() { return (key) => key } },
    slots: { inject(name, fn) { return fn() }, register(options, component) { slots.push({ options, component }); return () => {} } },
    connection: { generation: {}, rpc: { call() {} } },
    sessions: { binding() {} },
    effect(fn) { return fn() },
  })
  const { zh, en } = locales[0].dictionaries
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.equal(locales[0].ns, 'delegate-mode')
  // A switch states a condition, so both states need their own localized word;
  // showing the raw mode identifier is the same text in every language.
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    assert.ok(dict.toggle && dict.toggle !== 'delegate-writes', `${name}: toggle label must be translated`)
    assert.ok(dict.on && dict.off && dict.on !== dict.off, `${name}: needs distinct on/off words`)
    assert.ok(dict.hint.includes('{label}') && dict.hint.includes('{state}'), `${name}: hint interpolates placeholders`)
  }
  assert.notEqual(zh.toggle, en.toggle, 'the visible label must differ per language')
  assert.notEqual(zh.on, en.on, 'the state word must differ per language')
  // Rendered in the toolbar row immediately after the permission/plan controls.
  assert.equal(slots[0].options.name, 'conversation.input.left')
  assert.equal(slots[0].options.id, 'delegate-mode')
  const worker = slots[0].component({ sessionId: 'child', useSession: (selector) => selector({ running: false, removed: false, subagent: {} }) })
  assert.equal(worker, null)
  const loading = slots[0].component({ sessionId: 's', useSession: (selector) => selector({ running: false, removed: false, subagent: null }) })
  assert.equal(loading, null, 'no disabled control before the policy is known')
})

test('toggle is a single switch styled with the host permission control metrics', async () => {
  const styles = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { append(style) { styles.push(style) } },
  }
  const client = await load(document)
  client.apply({
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    slots: { inject(_name, fn) { return fn() }, register() { return () => {} } },
    connection: { generation: {}, rpc: { call() {} } },
    sessions: { binding() {} },
    effect(fn) { return fn() },
  })
  const css = styles[0].textContent
  assert.ok(/\.ysm-toggle\{[^}]*height:28px/.test(css), 'matches the 28px toolbar control height')
  assert.ok(css.includes('--dsw-radius-sm'), 'matches the host control radius token')
  assert.ok(css.includes('.ysm-toggle[aria-checked="true"]'), 'styles the on state')
  assert.ok(css.includes('--dsw-focus-ring-color'), 'uses the host focus ring')
  assert.equal(/ysm-dock|ysm-selector/.test(css), false, 'the dock/segmented control is gone')
})

test('RPC uses authenticated shared API and validates response identity and versions', async () => {
  const client = await load(), calls = []
  const rpc = client.__test.createRpc({ call: async (...args) => {
    calls.push(args)
    return { ok: true, value: { v: 1, sessionId: 's', mode: 'normal', revision: 0, busy: false, worker: false } }
  } }, true)
  assert.equal((await rpc.read('s')).mode, 'normal')
  await rpc.set('s', 'delegate-writes', 0)
  assert.equal(calls[0][0], '/api')
  assert.equal(calls[0][1], 'session-mode')
  assert.equal(calls[1][2].mode, 'delegate-writes')
  assert.equal(calls[1][2].revision, 0)
  const stale = client.__test.createRpc({ call: async () => ({ ok: true, value: { v: 1, sessionId: 'other', mode: 'normal', revision: 0 } }) }, true)
  await assert.rejects(() => stale.read('s'))
})
