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

/** Load the bundle against a chosen React, for tests that need real hooks. */
async function loadWith(React) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entry
  // The mounted effect subscribes to page-level signals (`focus`, and the
  // document's visibility) so a returning user is not shown a stale policy;
  // neither signal exists outside a browser, so the test records them instead.
  const listeners = new Map()
  const window = {
    __ModuleLoader__: { load(value) { entry = value } },
    addEventListener(name, fn) { listeners.set(name, fn) },
    removeEventListener(name) { listeners.delete(name) },
  }
  vm.runInNewContext(source, { window, AbortController })
  return entry.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
}

/**
 * Enough of the hooks contract to mount `ModeSelector`, update its state and
 * re-render it — which is what turns "a slot mutation arrives" into an
 * observable result instead of an assumption about the source.
 *
 * Effects run synchronously after each render (no scheduling), and a state update
 * from anywhere — an effect, a slot subscription, or a resolved promise — asks for
 * another render. That is sufficient because the component has no concurrent work.
 */
function createRuntime() {
  const cells = []
  const refs = []
  const effects = []
  const session = { running: false, removed: false, subagent: null }
  let cursor = 0
  let tree = null
  let pending = []
  let dirty = false
  let rendering = false

  const same = (left, right) => left !== undefined && right !== undefined
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const flush = () => {
    if (rendering) return
    rendering = true
    try {
      let guard = 0
      do {
        dirty = false
        cursor = 0
        pending = []
        tree = current()()
        for (const effect of pending) {
          const previous = effects[effect.index]
          if (previous !== undefined && same(previous.deps, effect.deps)) continue
          previous?.cleanup?.()
          const cleanup = effect.fn()
          effects[effect.index] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
        }
        guard += 1
        if (guard > 25) throw new Error('the component never settled')
      } while (dirty)
    } finally {
      rendering = false
    }
  }

  let current = () => () => null

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(cells[index]) : next
        if (Object.is(value, cells[index])) return
        cells[index] = value
        dirty = true
        if (!rendering) flush()
      }
      return [cells[index], set]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useEffect(fn, deps) {
      pending.push({ index: cursor++, fn, deps })
    },
  }

  return {
    React,
    /** Mount a factory product and settle it. */
    mount(factory) {
      current = () => () => factory({ sessionId: 's', useSession: (selector) => selector(session) })
      flush()
      return tree
    },
    /** Wait for promise work the component started, then render what it produced. */
    async settle() {
      for (let index = 0; index < 12; index += 1) await new Promise((resolve) => setImmediate(resolve))
      flush()
      return tree
    },
    get tree() { return tree },
  }
}

/** A `slots` face whose `conversation.input.left` occupants a test can change. */
function slotFace(ids = []) {
  const occupants = [...ids]
  const listeners = new Set()
  return {
    occupants,
    slots: {
      entries: (name) => (name === 'conversation.input.left'
        ? occupants.map((id) => ({ options: { id } }))
        : []),
      subscribe: (name, listener) => {
        assert.equal(name, 'conversation.input.left')
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    /** Mount or withdraw ds-bot's entry the way the host announces it. */
    change(next) {
      occupants.length = 0
      occupants.push(...next)
      for (const listener of [...listeners]) listener()
    },
  }
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

// ===== the Bot surface =====
//
// ds-bot replaces the composer in its own Bot surface and shadows the permission
// control into nothing, so a main agent's delegate switch has nothing to sit beside
// and must withdraw with it. The signal is ds-bot's own entry in the shared toolbar
// slot: it exists exactly while that composer is mounted, which also keeps the switch
// on a plain Agent Session opened inside the Bot surface.

/** A policy reply the selector accepts, so the toggle has something to render. */
const policyReply = (mode = 'normal') => ({
  ok: true,
  value: { v: 1, sessionId: 's', mode, revision: 0, busy: false, worker: false },
})

/** Mount the selector with real hooks against the given slot face. */
async function mountSelector(face, { reads = 0 } = {}) {
  const runtime = createRuntime()
  const loaded = await loadWith(runtime.React)
  const calls = []
  const rpc = {
    read: async (sessionId) => { calls.push(['read', sessionId]); return policyReply().value },
    set: async () => policyReply().value,
  }
  const factory = loaded.__test.createSelector(
    (key) => key,
    rpc,
    { generation: {} },
    { binding: () => undefined },
    face.slots,
  )
  const tree = runtime.mount(factory)
  await runtime.settle()
  const seen = calls.filter(([op]) => op === 'read').length
  assert.equal(seen >= reads, true, `expected at least ${reads} policy read(s), saw ${seen}`)
  return { runtime, tree, calls }
}

test('the switch is absent while the Bot composer occupies the toolbar slot', async () => {
  // Nothing is read, so the null below is the slot check alone — not a policy that
  // never arrived.
  const { runtime, calls } = await mountSelector(slotFace(['bot-plus']))
  assert.deepEqual(calls, [], 'the Bot surface asks nothing of the session')
  assert.equal(runtime.tree, null, 'a Bot composer has no permission control for the switch to sit beside')
})

test('the switch renders for a plain Agent Session, where no Bot composer is mounted', async () => {
  const { runtime } = await mountSelector(slotFace([]), { reads: 1 })
  const tree = runtime.tree
  assert.notEqual(tree, null, 'the standard composer keeps the switch')
  assert.equal(tree.type, 'button')
  assert.equal(tree.props.role, 'switch')
  assert.equal(tree.props['aria-label'], 'toggle')
  // Someone else's entry in the same slot must not be mistaken for ds-bot's.
  const other = await mountSelector(slotFace(['bot-voice', 'delegate-mode']), { reads: 1 })
  assert.notEqual(other.runtime.tree, null, 'only the composer entry itself hides the switch')
})

test('a surface switch removes and restores the switch without a reload', async () => {
  const face = slotFace([])
  const { runtime } = await mountSelector(face, { reads: 1 })
  assert.notEqual(runtime.tree, null, 'starts visible on the Agent surface')

  // Entering the Bot surface: ds-bot installs its composer and the slot announces it.
  face.change(['bot-plus'])
  assert.equal(runtime.tree, null, 'the switch withdraws in the same turn, with no reload')

  // Back to Agent mode: ds-bot disposes that entry.
  face.change([])
  assert.notEqual(runtime.tree, null, 'and comes back when the standard composer returns')
})

test('a Bot composer stops the pointless policy read', async () => {
  // The mode belongs to a main agent; asking a Bot surface's session for its policy
  // is a request whose answer is never shown.
  const { calls } = await mountSelector(slotFace(['bot-plus']), { reads: 0 })
  assert.deepEqual(calls, [], 'no /session-mode read while the Bot composer owns the slot')
})

test('the composer entry is named where ds-bot registers it', async () => {
  // A rename in ds-bot must not fail silently: this test is the reminder that the
  // constant mirrors `ds-bot/client.js`'s `{ id: 'bot-plus' }` shadow registration.
  const client = await load()
  assert.equal(client.__test.BOT_COMPOSER_ENTRY, 'bot-plus')
  assert.equal(client.__test.BOT_COMPOSER_SLOT, 'conversation.input.left')
  // Absent or foreign slot faces degrade to "shown", never to an invisible switch.
  assert.equal(client.__test.botComposerMounted(undefined), false)
  assert.equal(client.__test.botComposerMounted({}), false)
  assert.equal(client.__test.botComposerMounted({ entries() { throw new Error('boom') } }), false)
})
