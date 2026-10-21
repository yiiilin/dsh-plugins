/**
 * The gateway panel's three pages: 环境 / 凭据 / 会话.
 *
 * Two layers, for two different questions.
 *
 * The pure layer (`sessionView`, `credentialProblem`, `changeCredential`,
 * `credentialOutcomeText`) answers "what does the panel decide", which is where the
 * distinction this ticket exists for is made: a node that did not answer has no
 * session list at all, so it must not be rendered as a node nobody is signed in on.
 *
 * The rendered layer runs the shipped bundle in a `node:vm` sandbox with a
 * hook-capable React stub, so the real panel component is mounted, its tabs are
 * clicked and its form is typed into. That is the only way to observe that a
 * mismatch never becomes a request, and that the offline row really is not an empty
 * one — reading the source for the shape of those decisions is exactly what this
 * repository's newer tests do not do.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

import { PAIRING_CREDENTIAL_MIN_LENGTH } from '../lib/auth/pairing-credential.js'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** The mount a main node serves its harness under: every route resolves inside it. */
const BASE = 'http://127.0.0.1:3080/main/'
const STATE = `${BASE}admin/state`
const ENDPOINT = `${BASE}admin/credential`
const SESSIONS = `${BASE}admin/sessions`

/** What `/admin/state` answers for a main node with no environments registered. */
const MAIN_STATE = { status: 200, body: { ok: true, role: 'main', self: { role: 'main' }, environments: [] } }

// ===== a React-shaped hook runtime =====

/**
 * Build a React stub whose `createElement` returns a walkable tree and whose hooks
 * resolve by call order, so a function component renders outside a browser.
 *
 * @param component - the component to render; the panel takes no props.
 * @returns the stub plus `render`, `all`, and the current tree.
 */
function createHookRuntime(component) {
  const slots = []
  const STATE_SLOT = Symbol('state')
  const EFFECT_SLOT = Symbol('effect')
  const CALLBACK_SLOT = Symbol('callback')
  let cursor = 0
  let rendering = false
  let again = false
  let tree = null

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

  let render = () => {}

  const schedule = () => {
    // A state update from an event handler re-renders synchronously; one made while
    // rendering is folded into the render loop.
    if (rendering) again = true
    else render()
  }

  const hooks = {
    useState(initial) {
      const index = cursor++
      if (slots[index] === undefined) {
        slots[index] = { kind: STATE_SLOT, value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = slots[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }]
    },
    useCallback(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        slots[index] = { kind: CALLBACK_SLOT, deps: Array.isArray(deps) ? [...deps] : null, callback }
      }
      return slots[index].callback
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      slots[index] = { kind: EFFECT_SLOT, deps: Array.isArray(deps) ? [...deps] : null, effect, pending: true }
    },
  }

  const runEffects = () => {
    for (const slot of slots) {
      if (slot?.kind !== EFFECT_SLOT || slot.pending !== true) continue
      slot.pending = false
      const cleanup = slot.effect()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    ...hooks,
  }

  render = () => {
    if (rendering) {
      again = true
      return
    }
    rendering = true
    do {
      again = false
      cursor = 0
      tree = component()
      runEffects()
    } while (again)
    rendering = false
  }

  /** Every node in the tree matching `predicate`, in document order. */
  const all = (predicate) => {
    const found = []
    const stack = [tree]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === null || node === undefined || typeof node !== 'object') continue
      if (predicate(node)) found.push(node)
      // Reversed, because the stack pops from the end.
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index])
    }
    return found
  }

  return { React, render, all, get tree() { return tree } }
}

/** Every string in a subtree, in document order, on one line. */
function textOf(node) {
  const parts = []
  const walk = (current) => {
    if (typeof current === 'string') {
      parts.push(current)
      return
    }
    if (current === null || current === undefined || typeof current !== 'object') return
    for (const child of current.children) walk(child)
  }
  walk(node)
  return parts.join(' ').replace(/\s+/gu, ' ').trim()
}

// ===== sandboxed load =====

/**
 * Execute the shipped bundle with a recording `fetch`, and capture the panel page the
 * plugin registers into the `main` slot.
 *
 * @param answer - `(url, options) => { status, body }`; the fetch reply for one route.
 * @returns the exports, the requests made, and the registered panel component.
 */
function loadClient(answer = () => ({ status: 200, body: { ok: true } })) {
  const requests = []
  const fetch = async (input, options) => {
    const url = input instanceof URL ? input.href : String(input)
    requests.push({ url, options: options ?? {} })
    const reply = answer(url, options ?? {}) ?? { status: 200, body: { ok: true } }
    return { status: reply.status ?? 200, text: async () => JSON.stringify(reply.body ?? {}) }
  }

  let entry = null
  const window = { __ModuleLoader__: { load(spec) { entry = spec } } }
  const sandbox = { URL, document: { baseURI: BASE }, fetch, window }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 })
  assert.notEqual(entry, null, 'the bundle must register with window.__ModuleLoader__')
  assert.equal(typeof entry.factory, 'function', 'the registration must carry a factory')

  // The factory destructures React while it evaluates, before any runtime exists, so
  // each member has to resolve through the proxy at call time rather than be captured.
  const reactTarget = { current: null }
  const ReactProxy = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'Fragment') return 'fragment'
      return (...args) => {
        assert.notEqual(reactTarget.current, null, `react.${String(name)} was called before a runtime existed`)
        return reactTarget.current[name](...args)
      }
    },
  })
  const exported = entry.factory((name) => {
    if (name === 'react') return ReactProxy
    throw new Error(`unexpected client require: ${name}`)
  })

  const registered = []
  const locale = {
    register: () => () => {},
    bind: () => (key) => exported.__test.ZH[key] ?? key,
  }
  const slots = {
    inject: (_name, callback) => { callback(); return () => {} },
    register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {} },
  }
  // `apply` reads the services off the context directly, the way the loader hands them
  // over; `get` is provided too, for a context that only exposes that.
  const ctx = {
    locale,
    slots,
    get: (name) => ({ locale, slots })[name],
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  exported.apply(ctx)
  const panel = registered.find((row) => row.descriptor.name === 'main' && row.descriptor.key === 'gateway')
  assert.notEqual(panel, undefined, 'the panel page must be registered as main/gateway')

  return { exported, requests, reactTarget, component: panel.component }
}

/**
 * Mount the real panel component against a routed `fetch`.
 *
 * @param options.answer - the fetch router; see `loadClient`.
 * @returns the mounted page with the helpers the tests drive it through.
 */
function mount(options = {}) {
  const client = loadClient(options.answer)
  const runtime = createHookRuntime(client.component)
  client.reactTarget.current = runtime.React
  runtime.render()

  return {
    ...client,
    runtime,
    text: () => textOf(runtime.tree),
    buttons: () => runtime.all((node) => node.type === 'button'),
    /** The tab strip, identified by the pressed state it publishes. */
    tabs: () => runtime.all((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined),
    inputs: () => runtime.all((node) => node.type === 'input'),
    rows: () => runtime.all((node) => node.type === 'tr').map((row) => textOf(row)),
    requestsTo: (url) => client.requests.filter((request) => request.url === url),
    click(label) {
      const [button] = runtime.all((node) => node.type === 'button' && textOf(node) === label)
      assert.notEqual(button, undefined, `no button labelled ${label}`)
      button.props.onClick()
    },
    type(name, value) {
      const [input] = runtime.all((node) => node.type === 'input' && node.props.name === name)
      assert.notEqual(input, undefined, `no input named ${name}`)
      input.props.onChange({ target: { value } })
    },
    /** Let the component's async request paths settle. */
    async settle(rounds = 12) {
      for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

// ===== the three pages =====

test('offers exactly the three pages, and opens on the environment page', () => {
  const { exported } = loadClient()
  const { PANEL_TABS, DEFAULT_TAB, ZH, EN } = exported.__test

  assert.deepEqual([...PANEL_TABS].map((tab) => tab.id), ['environment', 'credential', 'sessions'])
  assert.equal(DEFAULT_TAB, 'environment')
  for (const tab of [...PANEL_TABS]) {
    assert.equal(typeof ZH[tab.labelKey], 'string', `the zh dictionary is missing ${tab.labelKey}`)
    assert.equal(typeof EN[tab.labelKey], 'string', `the en dictionary is missing ${tab.labelKey}`)
  }
})

test('renders the environment page first, and only that page', async () => {
  const page = mount({ answer: (url) => (url === STATE ? MAIN_STATE : undefined) })
  await page.settle()
  const { ZH } = page.exported.__test

  assert.deepEqual(page.tabs().map(textOf), [ZH.tabEnvironment, ZH.tabCredential, ZH.tabSessions])
  const text = page.text()
  assert.ok(text.includes(ZH.empty), 'the environment list is what opens')
  assert.ok(!text.includes(ZH.credentialSection), 'the credential form is not shown yet')
  assert.ok(!text.includes(ZH.sessionsSection), 'the session table is not shown yet')
})

test('the credential page shows its own copy and no data about the credential in force', async () => {
  const page = mount({ answer: (url) => (url === STATE ? MAIN_STATE : undefined) })
  await page.settle()
  const { ZH } = page.exported.__test

  page.click(ZH.tabCredential)
  const text = page.text()
  assert.ok(text.includes(ZH.credentialSection))
  assert.ok(!text.includes(ZH.empty), 'the environment page is gone')

  assert.deepEqual(page.inputs().map((input) => input.props.name), ['current', 'password', 'confirm'])
  for (const input of page.inputs()) {
    assert.equal(input.props.type, 'password', 'a credential is typed into a password field')
    assert.equal(input.props.value, '', 'the fields start empty')
  }

  // Nothing but the page's own copy is on screen: no timestamp, no mask, no hint about
  // the value in force. Longest copy first, so a short label cannot eat a longer one.
  const known = [
    ZH.title, ZH.hint, ZH.tabEnvironment, ZH.tabCredential, ZH.tabSessions,
    ZH.credentialSection, ZH.credentialHint, ZH.credentialCurrent, ZH.credentialNew,
    ZH.credentialConfirm, ZH.credentialSubmit,
  ].sort((a, b) => b.length - a.length)
  let rest = text
  for (const copy of known) rest = rest.replace(copy, '')
  assert.equal(rest.trim(), '', 'the credential page displays no data at all')
})

test('the environment page keeps the shape it had: edge note, failure note, create form', async () => {
  // The panel takes the role from `self`, which is what `/admin/state` reports about
  // this process; the top-level `role` is the same value.
  const edge = mount({ answer: (url) => (url === STATE ? { status: 200, body: { ok: true, role: 'edge', self: { role: 'edge' }, environments: [] } } : undefined) })
  await edge.settle()
  const { ZH } = edge.exported.__test
  assert.ok(edge.text().includes(ZH.edgeNote), 'an edge says it manages no environments')
  assert.ok(!edge.buttons().some((button) => textOf(button) === ZH.create), 'and is offered no create form')

  const failed = mount({ answer: () => ({ status: 500, body: { ok: false, error: 'boom' } }) })
  await failed.settle()
  assert.ok(failed.text().includes(ZH.unreachable), 'an unreadable daemon state says so')

  const main = mount({ answer: (url) => (url === STATE ? MAIN_STATE : undefined) })
  await main.settle()
  assert.ok(main.buttons().some((button) => textOf(button) === ZH.create), 'a main node keeps the create form')

  // One registered environment, in the shape `/admin/state` describes it.
  const listed = mount({
    answer: (url) => (url === STATE ? {
      status: 200,
      body: {
        ok: true,
        role: 'main',
        self: { role: 'main' },
        environments: [{ id: 'nalpha', label: 'alpha', online: true, hostname: 'alpha.example', lastSeen: 1_700_000_000_000 }],
      },
    } : undefined),
  })
  await listed.settle()
  const card = listed.text()
  assert.ok(card.includes('alpha'), 'the environment is listed by name')
  assert.ok(card.includes('alpha.example'), 'with the host it reported')
  assert.deepEqual(
    listed.buttons().map(textOf).filter((label) => [ZH.open, ZH.rename, ZH.rotate, ZH.remove].includes(label)),
    [ZH.open, ZH.rename, ZH.rotate, ZH.remove],
    'and the same four actions it had before the tabs',
  )
})

// ===== the credential form =====

test('refuses a short or mismatched new credential before any request', async () => {
  const page = mount({ answer: (url) => (url === STATE ? MAIN_STATE : undefined) })
  await page.settle()
  const { ZH, CREDENTIAL_MIN_LENGTH } = page.exported.__test
  page.click(ZH.tabCredential)

  page.type('current', 'pairing credential 7b31')
  page.type('password', 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1))
  page.type('confirm', 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1))
  page.click(ZH.credentialSubmit)
  await page.settle()
  assert.equal(page.requestsTo(ENDPOINT).length, 0, 'a short entry is not sent')
  assert.ok(page.text().includes(ZH.credentialTooShort.replace('{count}', String(CREDENTIAL_MIN_LENGTH))))

  page.type('password', 'x'.repeat(CREDENTIAL_MIN_LENGTH))
  page.type('confirm', 'y'.repeat(CREDENTIAL_MIN_LENGTH))
  page.click(ZH.credentialSubmit)
  await page.settle()
  assert.equal(page.requestsTo(ENDPOINT).length, 0, 'a mismatch is not sent')
  assert.ok(page.text().includes(ZH.credentialMismatch))
})

test('sends the three fields, clears them, and confirms the change', async () => {
  const page = mount({
    answer: (url) => (url === STATE ? MAIN_STATE : url === ENDPOINT ? { status: 200, body: { ok: true } } : undefined),
  })
  await page.settle()
  const { ZH, CREDENTIAL_MIN_LENGTH } = page.exported.__test
  page.click(ZH.tabCredential)

  const password = 'z'.repeat(CREDENTIAL_MIN_LENGTH)
  page.type('current', 'pairing credential 7b31')
  page.type('password', password)
  page.type('confirm', password)
  page.click(ZH.credentialSubmit)
  await page.settle()

  const posts = page.requestsTo(ENDPOINT)
  assert.equal(posts.length, 1, 'exactly one change is sent')
  assert.equal(posts[0].options.method, 'POST')
  assert.equal(posts[0].options.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(posts[0].options.body), {
    current: 'pairing credential 7b31',
    password,
    confirm: password,
  })

  assert.deepEqual(page.inputs().map((input) => input.props.value), ['', '', ''], 'the fields are cleared')
  assert.ok(page.text().includes(ZH.credentialChanged), 'and the change is confirmed')
})

test('reports a wrong current credential in the reader\'s language', async () => {
  const daemonSaid = 'the current pairing credential is not correct'
  const page = mount({
    answer: (url) => (url === STATE ? MAIN_STATE : url === ENDPOINT ? { status: 403, body: { ok: false, error: daemonSaid } } : undefined),
  })
  await page.settle()
  const { ZH } = page.exported.__test
  page.click(ZH.tabCredential)

  page.type('current', 'not the credential')
  page.type('password', 'y'.repeat(20))
  page.type('confirm', 'y'.repeat(20))
  page.click(ZH.credentialSubmit)
  await page.settle()

  const text = page.text()
  assert.ok(text.includes(ZH.credentialWrongCurrent), 'the refusal is said in the page\'s language')
  assert.ok(!text.includes(daemonSaid), 'the daemon answers in English whatever the reader speaks')
})

// ===== the session table =====

/** One session on this host, one node with nothing, one node that did not answer. */
const OVERVIEW = {
  status: 200,
  body: {
    ok: true,
    partial: true,
    nodes: [
      {
        id: 'self',
        role: 'main',
        state: 'ok',
        sessions: [{
          id: 'sess-1',
          address: '10.0.0.5',
          userAgent: 'Mozilla/5.0 (X11)',
          issuedAt: 1_700_000_000_000,
          lastSeenAt: 1_700_000_060_000,
          expiresAt: 1_700_086_400_000,
          current: true,
        }],
      },
      { id: 'nalpha', role: 'edge', label: 'alpha', state: 'ok', sessions: [] },
      { id: 'nbeta', role: 'edge', label: 'beta', state: 'offline', error: 'environment "nbeta" is offline' },
    ],
  },
}

test('draws an unreadable node as unreadable, never as an empty session list', async () => {
  const page = mount({ answer: (url) => (url === STATE ? MAIN_STATE : url === SESSIONS ? OVERVIEW : undefined) })
  await page.settle()
  const { ZH } = page.exported.__test

  page.click(ZH.tabSessions)
  await page.settle()

  const text = page.text()
  assert.ok(text.includes(ZH.sessionsSection))
  assert.ok(text.includes(ZH.sessionsPartial), 'the table says it is incomplete')
  // Every field the ticket names is on the row.
  assert.ok(text.includes('10.0.0.5'), 'client address')
  assert.ok(text.includes('Mozilla/5.0 (X11)'), 'client type')
  assert.ok(text.includes('sess-1'), 'identifier')
  assert.ok(text.includes(ZH.nodeSelf), 'the node it belongs to')
  assert.ok(text.includes('alpha'))
  assert.ok(text.includes('beta'))

  const rows = page.rows()
  assert.equal(rows.length, 4, 'a header and one row per entry')

  const alpha = rows.find((row) => row.includes('alpha'))
  assert.ok(alpha.includes(ZH.sessionsEmptyNode), 'a node that answered with nothing says so')
  assert.ok(!alpha.includes(ZH.sessionsUnreadable), 'and is not reported as unreadable')

  const beta = rows.find((row) => row.includes('beta'))
  assert.ok(beta.includes(ZH.offline), 'the state is on the row')
  assert.ok(beta.includes(ZH.sessionsUnreadable), 'an unreadable node is not an empty list')
  assert.ok(beta.includes('environment "nbeta" is offline'), 'and its error is shown')
  assert.ok(!beta.includes(ZH.sessionsEmptyNode), 'it is never rendered as empty')
})

test('the session page is read-only: it offers no action on a session', async () => {
  const page = mount({ answer: (url) => (url === STATE ? MAIN_STATE : url === SESSIONS ? OVERVIEW : undefined) })
  await page.settle()
  const { ZH } = page.exported.__test
  page.click(ZH.tabSessions)
  await page.settle()

  // The refresh pill and the three tabs, and nothing that would act on a row.
  assert.deepEqual(page.buttons().map(textOf), [ZH.refresh, ZH.tabEnvironment, ZH.tabCredential, ZH.tabSessions])
})

// ===== the session payload, without a renderer =====

/** One live session, in the shape the daemon answers with. */
const SESSION = {
  id: 'sess-1',
  address: '10.0.0.5',
  userAgent: 'Mozilla/5.0 (X11)',
  issuedAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_060_000,
  expiresAt: 1_700_086_400_000,
  current: true,
}

test('turns a node answer into one row per session, carrying every field', () => {
  const { sessionView } = loadClient().exported.__test
  const view = sessionView({
    ok: true,
    partial: false,
    nodes: [{ id: 'self', role: 'main', state: 'ok', sessions: [SESSION, { ...SESSION, id: 'sess-2', current: false }] }],
  })

  assert.equal(view.partial, false)
  const entries = [...view.entries]
  assert.deepEqual(entries.map((entry) => entry.kind), ['session', 'session'])
  assert.deepEqual(
    {
      node: entries[0].node.id,
      id: entries[0].session.id,
      address: entries[0].session.address,
      userAgent: entries[0].session.userAgent,
      issuedAt: entries[0].session.issuedAt,
      lastSeenAt: entries[0].session.lastSeenAt,
      expiresAt: entries[0].session.expiresAt,
      current: entries[0].session.current,
    },
    {
      node: 'self',
      id: 'sess-1',
      address: '10.0.0.5',
      userAgent: 'Mozilla/5.0 (X11)',
      issuedAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_060_000,
      expiresAt: 1_700_086_400_000,
      current: true,
    },
  )
  assert.equal(entries[1].session.current, false)
})

test('an unreadable node is not an empty node', () => {
  const { sessionView } = loadClient().exported.__test

  for (const [state, error] of [
    ['offline', 'environment "nbeta" is offline'],
    ['timeout', 'the environment did not answer in time'],
    ['error', 'the environment answered something that is not JSON'],
  ]) {
    // The daemon omits `sessions` on such a node; a `[]` must not change the reading.
    const view = sessionView({
      ok: true,
      partial: true,
      nodes: [{ id: 'nbeta', label: 'beta', state, error, sessions: [] }],
    })
    const entries = [...view.entries]
    assert.equal(entries.length, 1, `${state}: the node is still one entry`)
    assert.equal(entries[0].kind, 'unreadable', `${state}: and it is not a session list`)
    assert.equal(entries[0].node.state, state, `${state}: its state is carried`)
    assert.equal(entries[0].node.error, error, `${state}: and so is its error`)
  }

  // A node that answered with nothing is the other case, and it says so.
  const empty = sessionView({ ok: true, partial: false, nodes: [{ id: 'nbeta', label: 'beta', state: 'ok', sessions: [] }] })
  const entries = [...empty.entries]
  assert.deepEqual(entries.map((entry) => entry.kind), ['empty'])
  assert.equal(entries[0].node.state, 'ok')
  assert.equal(entries[0].node.error, undefined, 'an empty node carries no error')
})

test('surfaces partial answers, and never claims completeness while a node is unreadable', () => {
  const { sessionView } = loadClient().exported.__test
  const ok = [{ id: 'self', state: 'ok', sessions: [] }]

  assert.equal(sessionView({ ok: true, partial: true, nodes: ok }).partial, true)
  assert.equal(sessionView({ ok: true, partial: false, nodes: ok }).partial, false)
  // The daemon's flag is trusted, but an unreadable node is proof on its own.
  assert.equal(sessionView({ ok: true, nodes: [{ id: 'nbeta', state: 'offline' }] }).partial, true)

  // Nothing to show is not the same as a broken answer: it is simply an empty table.
  const none = sessionView({ ok: true, partial: false, nodes: [] })
  assert.equal(none.partial, false)
  assert.equal([...none.entries].length, 0)
  const broken = sessionView(undefined)
  assert.equal(broken.partial, false)
  assert.equal([...broken.entries].length, 0)
})

test('gives each unreadable state its own word', () => {
  const { nodeStateKey, ZH, EN } = loadClient().exported.__test
  assert.equal(nodeStateKey('offline'), 'offline')
  assert.equal(nodeStateKey('timeout'), 'nodeTimeout')
  assert.equal(nodeStateKey('error'), 'nodeError')
  // An unknown state is still a failure to read, and is said as one.
  assert.equal(nodeStateKey('nonsense'), 'nodeError')
  assert.equal(nodeStateKey(undefined), 'nodeError')
  for (const key of ['offline', 'nodeTimeout', 'nodeError']) {
    assert.equal(typeof ZH[key], 'string', `the zh dictionary is missing ${key}`)
    assert.equal(typeof EN[key], 'string', `the en dictionary is missing ${key}`)
  }
})

test('names a node by its label, and this host by the panel\'s own word for it', () => {
  const { nodeDisplayName, formatTime } = loadClient().exported.__test
  assert.equal(nodeDisplayName({ id: 'nalpha', label: 'alpha' }, '本机'), 'alpha')
  assert.equal(nodeDisplayName({ id: 'self' }, '本机'), '本机')
  assert.equal(nodeDisplayName({ id: 'nbeta' }, '本机'), 'nbeta')
  // A missing or unreadable timestamp is a dash, never "Invalid Date".
  assert.equal(formatTime(undefined), '—')
  assert.equal(formatTime(Number.NaN), '—')
  assert.notEqual(formatTime(1_700_000_000_000), '—')
})

// ===== the credential form's rules, without a renderer =====

test('holds the form to the daemon\'s own rule for a new credential', () => {
  const { credentialProblem, CREDENTIAL_MIN_LENGTH, ZH, EN } = loadClient().exported.__test
  assert.equal(CREDENTIAL_MIN_LENGTH, PAIRING_CREDENTIAL_MIN_LENGTH, 'the form repeats the daemon\'s minimum')

  const password = 'x'.repeat(CREDENTIAL_MIN_LENGTH)
  const good = { current: 'pairing credential 7b31', password, confirm: password }
  assert.equal(credentialProblem(good), null)
  assert.equal(credentialProblem({ ...good, password: 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1), confirm: 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1) }), 'credentialTooShort')
  assert.equal(credentialProblem({ ...good, confirm: `${password}y` }), 'credentialMismatch')
  assert.equal(credentialProblem({ ...good, password: '', confirm: '' }), 'credentialEmpty')
  assert.equal(credentialProblem({ ...good, current: '' }), 'credentialCurrentRequired')
  assert.equal(credentialProblem(undefined), 'credentialCurrentRequired')

  // Every refusal has copy in both dictionaries, or the form would fall back to a key.
  for (const form of [
    { ...good, password: '', confirm: '' },
    { ...good, password: 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1), confirm: 'x'.repeat(CREDENTIAL_MIN_LENGTH - 1) },
    { ...good, confirm: `${password}y` },
    { ...good, current: '' },
  ]) {
    const key = credentialProblem(form)
    assert.equal(typeof ZH[key], 'string', `the zh dictionary is missing ${key}`)
    assert.equal(typeof EN[key], 'string', `the en dictionary is missing ${key}`)
  }
})

test('says an outcome in the reader\'s language', () => {
  const { credentialOutcomeText, ZH, CREDENTIAL_MIN_LENGTH } = loadClient().exported.__test
  const t = (key) => ZH[key] ?? key

  assert.equal(credentialOutcomeText(t, { phase: 'done' }), ZH.credentialChanged)
  assert.equal(
    credentialOutcomeText(t, { phase: 'invalid', problem: 'credentialTooShort' }),
    ZH.credentialTooShort.replace('{count}', String(CREDENTIAL_MIN_LENGTH)),
  )
  assert.equal(credentialOutcomeText(t, { phase: 'failed', status: 403, error: 'whatever' }), ZH.credentialWrongCurrent)
  assert.equal(
    credentialOutcomeText(t, { phase: 'failed', status: 400, error: 'the new pairing credential must not be empty' }),
    ZH.credentialFailed.replace('{message}', 'the new pairing credential must not be empty'),
  )
})

test('changeCredential never calls the endpoint for a form it already refused', async () => {
  const { changeCredential } = loadClient().exported.__test
  const sent = []
  const post = async (body) => {
    sent.push(body)
    return { ok: true, status: 200 }
  }

  const refused = await changeCredential({ current: 'old', password: 'short', confirm: 'short' }, post)
  assert.equal(refused.phase, 'invalid')
  assert.equal(refused.problem, 'credentialTooShort')
  assert.equal(sent.length, 0, 'nothing was sent')

  const mismatched = await changeCredential({ current: 'old', password: 'x'.repeat(20), confirm: 'y'.repeat(20) }, post)
  assert.equal(mismatched.phase, 'invalid')
  assert.equal(mismatched.problem, 'credentialMismatch')
  assert.equal(sent.length, 0, 'nothing was sent')

  const accepted = await changeCredential({ current: 'old', password: 'x'.repeat(20), confirm: 'x'.repeat(20) }, post)
  assert.equal(accepted.phase, 'done')
  assert.equal(sent.length, 1, 'a valid form is sent once')
  assert.deepEqual(Object.keys(sent[0]).sort(), ['confirm', 'current', 'password'], 'and carries exactly the three fields')
})

// ===== the dictionaries =====

test('keeps the zh and en dictionaries key-for-key', () => {
  const { ZH, EN } = loadClient().exported.__test
  const zh = Object.keys(ZH).sort()
  const en = Object.keys(EN).sort()
  assert.ok(zh.length > 0)
  assert.deepEqual(zh, en)
  // Every new key of this change is user-visible copy, so none may be empty.
  for (const key of zh) {
    assert.notEqual(String(ZH[key]).trim(), '', `zh.${key} is empty`)
    assert.notEqual(String(EN[key]).trim(), '', `en.${key} is empty`)
  }
})
