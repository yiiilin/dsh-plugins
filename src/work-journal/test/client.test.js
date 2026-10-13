import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Load the browser bundle and hand back its factory result.
 * @param options - `document` for the stylesheet path and `react` for a stub.
 */
async function load(options = {}) {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let entry
  const context = { window: { __ModuleLoader__: { load(value) { entry = value } } }, AbortController }
  if (options.document !== undefined) context.document = options.document
  vm.runInNewContext(source, context)
  return entry.factory((name) => {
    assert.equal(name, 'react')
    return options.react ?? {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (value) => [value, () => {}],
      useRef: (value) => ({ current: value }),
      useEffect() {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    }
  })
}

/** A recording Cordis-shaped client context. */
function harness() {
  const recorded = { locales: [], slots: [], tabs: [], effects: [], styles: [] }
  const services = {
    slots: {
      inject(name, factory) { return factory() },
      register(options, component) {
        recorded.slots.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        recorded.tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: { openTab() {}, isExpanded: () => true },
    locale: {
      register(ns, dictionaries) {
        recorded.locales.push({ ns, dictionaries })
        return () => {}
      },
      bind: () => (key) => key,
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  }
  const ctx = {
    ...services,
    get: (name) => services[name],
    effect(factory, label) {
      recorded.effects.push({ label, dispose: factory() })
    },
  }
  return { ctx, recorded }
}

test('registers one right-sidebar tab with a guide entry and a localized dictionary', async () => {
  const client = await load()
  const { ctx, recorded } = harness()
  client.apply(ctx)

  assert.equal(recorded.locales.length, 1)
  assert.equal(recorded.locales[0].ns, 'work-journal')
  const { zh, en } = recorded.locales[0].dictionaries
  // Every user-visible string is localized in both languages, and a missing key
  // in one dictionary would show a raw identifier to that language's users.
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const keys = [
    'title', 'guide.description', 'refresh', 'loading', 'unavailable', 'failed',
    'emptyList', 'search', 'searchPlaceholder', 'searching', 'searchEmpty',
    'searchResults', 'score', 'snippet', 'span', 'generatedAt',
    'kind.day', 'kind.week', 'kind.month',
    'status.ok', 'status.failed', 'status.generating',
    'detail', 'back', 'copy', 'copied', 'missing', 'emptyBody',
  ]
  for (const key of keys) {
    assert.ok(zh[key], `zh is missing ${key}`)
    assert.ok(en[key], `en is missing ${key}`)
  }
  assert.notEqual(zh.title, en.title)

  // The live-query vocabulary is gone: the data source is generated reports,
  // not a range over the session log.
  for (const dead of ['range.day', 'range.week', 'range.month', 'range.recent', 'range.all', 'promptsSection', 'activeDays', 'toolCalls']) {
    assert.equal(zh[dead], undefined, `${dead} should no longer be localized`)
    assert.equal(en[dead], undefined, `${dead} should no longer be localized`)
  }

  assert.equal(recorded.tabs.length, 1)
  const tab = recorded.tabs[0]
  assert.equal(tab.kind, 'work-journal.journal')
  assert.equal(tab.priority, 'extension')
  assert.equal(tab.title(), 'title')
  assert.equal(tab.guide.length, 1)
  assert.equal(tab.guide[0].id, 'work-journal')
  assert.equal(typeof tab.guide[0].icon, 'function')

  // The panel lives on the left rail beside 插件 / 自动化任务, with its page in
  // the product's `main` seat — that pairing is what makes the button navigate.
  const byName = (name) => recorded.slots.filter((entry) => entry.options.name === name)
  const buttons = byName('sidebar.panellist')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].options.id, 'work-journal')
  assert.equal(buttons[0].options.order, 20)
  assert.equal(buttons[0].options.label(), 'title')
  assert.equal(typeof buttons[0].component, 'function')

  const mains = byName('main')
  assert.equal(mains.length, 1)
  assert.equal(mains[0].options.key, 'work-journal')
  assert.equal(typeof mains[0].component, 'function')

  // The right-sidebar tab and its body seat are retained, not moved.
  const bodies = byName('sidebar.right.pane.tab')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].options.key, '@yiln-dsh/dsh-plugins/work-journal')
  assert.equal(typeof bodies[0].component, 'function')
})

test('declares the services it reads so the client host can resolve them', async () => {
  const client = await load()
  assert.deepEqual([...client.inject].sort(), ['connection', 'locale', 'sidebarRight', 'sidebarRightTabs', 'slots'].sort())
  assert.equal(typeof client.apply, 'function')
})

test('does nothing when the product has no right sidebar to contribute to', async () => {
  const client = await load()
  const effects = []
  client.apply({
    get: () => undefined,
    effect(factory, label) { effects.push(label) },
  })
  assert.deepEqual(effects, [])
})

test('maps a transport failure to one unavailable error rather than leaking the shape', async () => {
  const client = await load()
  const failure = client.__test.createClient({ call: async () => { throw new Error('socket closed') } })
  await assert.rejects(() => failure.list({}), (error) => error.code === 'unavailable')

  const refused = client.__test.createClient({ call: async () => ({ ok: false, error: { code: 'failed', message: 'index missing' } }) })
  await assert.rejects(() => refused.search({ query: 'x' }), (error) => error.code === 'failed' && /index missing/u.test(error.message))

  // The host reports a missing report and an unopened store as their own codes;
  // flattening them to `failed` would show "read failed" for both.
  const missing = client.__test.createClient({ call: async () => ({ ok: false, error: { code: 'not-found', message: 'no such report' } }) })
  await assert.rejects(() => missing.get({ key: '2026-01-01' }), (error) => error.code === 'not-found')
  const closed = client.__test.createClient({ call: async () => ({ ok: false, error: { code: 'unavailable', message: 'store closed' } }) })
  await assert.rejects(() => closed.list({}), (error) => error.code === 'unavailable')

  const ok = client.__test.createClient({ call: async (_channel, endpoint) => ({ ok: true, value: { endpoint } }) })
  assert.deepEqual(plain(await ok.get({ key: '2026-10-12' })), { endpoint: 'get' })
})

/**
 * Regression: the old range switch called `.abort()` on the stored
 * `{controller, live}` pair instead of its controller, so choosing 今日 after
 * 本周 threw "active.current?.abort is not a function" and the panel unmounted
 * into a blank page.
 */
/**
 * A period boundary is defined by the timezone the report was bucketed in, so
 * the span must render in the host's offset rather than the browser's or UTC.
 * Rendering UTC showed `2026-10-11 16:00 ~ 2026-10-12 15:59` for a report whose
 * own body says `2026-10-12 00:00:00 ~ 2026-10-12 23:59:59`.
 */
test('renders a span in the host offset the response carried', async () => {
  const client = await load()
  const { formatSpan, formatStamp, offsetOf } = client.__test
  // 2026-10-12 00:00:00 and 23:59:59.999 at UTC+8.
  const start = Date.UTC(2026, 9, 11, 16, 0, 0)
  const end = Date.UTC(2026, 9, 12, 15, 59, 59, 999)

  assert.equal(formatStamp(start, 480), '2026-10-12 00:00')
  assert.equal(formatStamp(start, 0), '2026-10-11 16:00')
  assert.equal(formatSpan(start, end, 480), '2026-10-12 00:00 ~ 2026-10-12 23:59')
  // Without an offset (an older host) the span is UTC, not the browser's zone.
  assert.equal(formatSpan(start, end, undefined), '2026-10-11 16:00 ~ 2026-10-12 15:59')
  assert.equal(formatStamp(Number.NaN, 480), '')
  // The response offset is read defensively.
  assert.equal(offsetOf({ tzOffsetMinutes: 480 }), 480)
  assert.equal(offsetOf({}), 0)
  assert.equal(offsetOf(undefined), 0)
})

test('cancelling an in-flight load aborts the controller and marks the load dead', async () => {
  const client = await load()
  const { cancelActive } = client.__test

  let aborted = false
  const ref = { current: { live: true, controller: { abort() { aborted = true } } } }
  cancelActive(ref)
  assert.equal(aborted, true, 'the controller must be aborted')
  assert.equal(ref.current.live, false, 'a late response must not set state')

  // An empty ref is the first load, and must not throw.
  assert.doesNotThrow(() => cancelActive({ current: null }))
  assert.doesNotThrow(() => cancelActive(undefined))
})

test('the panel client posts each endpoint to the shared /api channel with its payload', async () => {
  const calls = []
  const client = client0(await load(), calls)
  await client.list({ limit: 100 })
  await client.get({ key: '2026-10-12' })
  await client.search({ query: '面板', mode: 'hybrid', limit: 30 })
  assert.equal(calls.length, 3)
  for (const entry of calls) {
    assert.equal(entry.channel, '/api')
    assert.equal(entry.method, 'work-journal')
  }
  assert.deepEqual(plain(calls[0].payload), { endpoint: 'list', payload: { limit: 100 } })
  assert.deepEqual(plain(calls[1].payload), { endpoint: 'get', payload: { key: '2026-10-12' } })
  assert.deepEqual(plain(calls[2].payload), { endpoint: 'search', payload: { query: '面板', mode: 'hybrid', limit: 30 } })
})

test('the legacy runtime keeps the positional /work-journal channel', async () => {
  const calls = []
  const module = await load()
  const client = module.__test.createClient({
    call: async (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, payload })
      return { ok: true, value: {} }
    },
  }, false)
  await client.list({ limit: 100 })
  assert.equal(calls[0].channel, '/work-journal')
  assert.equal(calls[0].endpoint, 'list')
  assert.deepEqual(plain(calls[0].payload), { limit: 100 })
})

/** Build a client whose RPC calls are recorded. */
function client0(module, calls) {
  return module.__test.createClient({
    call: async (channel, method, payload) => {
      calls.push({ channel, method, payload })
      return { ok: true, value: {} }
    },
  }, true)
}

test('formats the report time span, collapsing a zero-width period', async () => {
  const client = await load()
  const { formatSpan, formatStamp, formatScore } = client.__test
  // A day: midnight to the last millisecond of the day.
  assert.equal(formatStamp(Date.UTC(2026, 9, 12)), '2026-10-12 00:00')
  assert.equal(formatSpan(Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999)), '2026-10-12 00:00 ~ 2026-10-12 23:59')
  // A week: the ISO range the user asked to see on every entry.
  assert.equal(formatSpan(Date.UTC(2026, 9, 6), Date.UTC(2026, 9, 12)), '2026-10-06 00:00 ~ 2026-10-12 00:00')
  // No width, or unusable input, still yields exactly one readable instant.
  assert.equal(formatSpan(Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12)), '2026-10-12 00:00')
  assert.equal(formatSpan(Date.UTC(2026, 9, 12), undefined), '2026-10-12 00:00')
  assert.equal(formatSpan(undefined, undefined), '')
  assert.equal(formatStamp(Number.NaN), '')
  assert.equal(formatScore(0.5), '0.50')
  assert.equal(formatScore(undefined), '')
})

/**
 * A minimal React stub with working state, refs and effects, so the panel can
 * be driven: render it, read the tree, invoke a handler, render again.
 */
/** React's dependency comparison: absent deps mean "every render". */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function stubReact() {
  const hook = { order: 0, states: [], effects: [], refs: [], slots: [] }
  return {
    hook,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = hook.order++
      if (!(index in hook.states)) hook.states[index] = initial
      return [hook.states[index], (next) => {
        hook.states[index] = typeof next === 'function' ? next(hook.states[index]) : next
      }]
    },
    useRef(initial) {
      const index = hook.order++
      if (!(index in hook.refs)) hook.refs[index] = { current: initial }
      return hook.refs[index]
    },
    useEffect(fn, deps) {
      hook.effects.push({ fn, deps })
    },
    // Memoized by deps, as React does: a fresh closure identity each render
    // would make every effect that depends on a callback re-run on every paint.
    useCallback(fn, deps) {
      const index = hook.order++
      const slot = hook.slots[`cb${index}`]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value
      hook.slots[`cb${index}`] = { deps, value: fn }
      return fn
    },
    useMemo(fn, deps) {
      const index = hook.order++
      const slot = hook.slots[`mm${index}`]
      if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value
      const value = fn()
      hook.slots[`mm${index}`] = { deps, value }
      return value
    },
  }
}

/**
 * Run the effects a render registered, honouring their dependency lists: an
 * effect with unchanged deps keeps its previous cleanup and is not re-run, which
 * is what stops a mount-only fetch from firing on every render.
 * @returns the cleanups, in hook order.
 */
function runEffects(react, effects) {
  const cleanups = []
  effects.forEach((effect, index) => {
    const slot = react.hook.slots[`fx${index}`]
    if (slot !== undefined && sameDeps(slot.deps, effect.deps)) {
      if (typeof slot.cleanup === 'function') cleanups.push(slot.cleanup)
      return
    }
    if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
    const cleanup = effect.fn()
    react.hook.slots[`fx${index}`] = { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  })
  return cleanups
}

/** Every node in a rendered tree, in paint order. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) {
    if (Array.isArray(child)) for (const nested of child) walk(nested, out)
    else walk(child, out)
  }
  return out
}

/** All rendered text, joined — the panel's user-visible output. */
function textOf(tree) {
  const text = []
  const collect = (node) => {
    if (typeof node === 'string' || typeof node === 'number') { text.push(String(node)); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    for (const child of node.children ?? []) {
      if (Array.isArray(child)) child.forEach(collect)
      else collect(child)
    }
  }
  collect(tree)
  return text.join('|')
}

/** The first node whose props satisfy a predicate. */
function find(tree, predicate) {
  return walk(tree).find((node) => node.props !== undefined && predicate(node))
}

/** Every node with one class, in paint order. */
function byClass(tree, className) {
  return walk(tree).filter((node) => node.props?.className === className)
}

/**
 * The report rows, in render order, as `{ label, badge, status, span, onClick }`.
 *
 * Read by class rather than by child position, so a row that grows an optional
 * part (an error line, a score) does not silently shift the assertions.
 */
function rows(tree) {
  return byClass(tree, 'wj-item').map((node) => {
    const parts = walk(node)
    const textOfClass = (className) => parts.find((part) => part.props?.className === className)?.children[0]
    const head = parts.find((part) => part.props?.className === 'wj-item-head')
    const headParts = walk(head)
    return {
      label: headParts.find((part) => part.props?.className === 'wj-item-label')?.children[0],
      badge: headParts.find((part) => String(part.props?.className).startsWith('wj-badge'))?.children[0],
      status: headParts.find((part) => String(part.props?.className).startsWith('wj-status'))?.children[0],
      score: headParts.find((part) => part.props?.className === 'wj-score')?.children[0],
      span: textOfClass('wj-span'),
      snippet: textOfClass('wj-snippet'),
      onClick: node.props.onClick,
      disabled: node.props.disabled,
    }
  })
}

/** A meta record shaped exactly like the frozen interface. */
function meta(key, kind, startTime, endTime, extra = {}) {
  return {
    version: 1,
    key,
    kind,
    label: key,
    startTime,
    endTime,
    generatedAt: endTime,
    model: { provider: 'subagent-gpt', model: 'deepseek-flash' },
    status: 'ok',
    sessionCount: 1,
    error: null,
    ...extra,
  }
}

const TEST_DICT = {
  'loading': '正在读取…',
  'emptyList': '还没有生成任何报告。',
  'searchResults': '搜索结果',
  'searching': '正在搜索…',
  'searchEmpty': '没有匹配的报告。',
  'failed': '读取失败：{message}',
  'unavailable': '工作日志服务不可用。',
  'missing': '这份报告已不存在。',
  'emptyBody': '这份报告没有正文。',
  'back': 'back',
  'copy': 'copy',
  'copied': 'copied',
  'kind.day': '日报',
  'kind.week': '周报',
  'kind.month': '月报',
  'status.ok': '正常',
  'status.failed': 'failed',
  'status.generating': '生成中',
}

/** Translate through the panel's own `t`, so the copy under test is the copy shipped. */
function t(key, params) {
  const raw = TEST_DICT[key] ?? key
  return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/gu, (match, name) => String(params[name]))
}

/**
 * The bundle runs in a VM realm, so a value it built carries that realm's
 * prototypes and fails `deepStrictEqual` against a literal. Compare plain JSON.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Yield to the microtask queue so awaited RPC results land. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * Mount the panel against a recording client and a controllable debounce.
 *
 * The panel takes its timer from the injected scheduler, so the test owns the
 * pending search and fires it explicitly instead of sleeping out the delay.
 */
async function mount(responders) {
  const react = stubReact()
  const client = await load({ react })
  const calls = []
  const timers = new Map()
  let nextTimer = 1
  const schedule = {
    later(fn, ms) { const id = nextTimer; nextTimer += 1; timers.set(id, { fn, ms }); return id },
    cancel(id) { timers.delete(id) },
  }
  const rpc = {
    call: async (channel, method, payload, signal) => {
      calls.push({ channel, method, payload })
      const responder = responders[payload?.endpoint]
      if (responder === undefined) return { ok: true, value: {} }
      return responder(payload.payload, signal)
    },
  }
  const Panel = client.__test.createPanel(t, client.__test.createClient(rpc, true), schedule)
  /**
   * Render, run whatever effects the mount registered, let the awaited RPC
   * settle, then render again — the tree a real React render would paint after
   * the state update, not the one from before the `await`.
   */
  const render = async () => {
    const pass = () => {
      react.hook.order = 0
      react.hook.effects = []
      const tree = Panel()
      const effects = react.hook.effects
      react.hook.effects = []
      return { tree, effects }
    }
    cleanups = runEffects(react, pass().effects)
    await flush()
    return pass().tree
  }
  let cleanups = []
  const first = await render()
  return {
    first,
    calls,
    timers,
    render,
    /** The cleanups the last render left registered, in hook order. */
    get cleanups() { return cleanups },
    /** Fire the pending debounce without waiting out the real delay. */
    async flushTimers() {
      const due = [...timers.values()]
      timers.clear()
      for (const timer of due) timer.fn()
      await flush()
    },
  }
}

test('the list is newest period first and every entry carries its time span', async () => {
  const panel = await mount({
    list: async () => ({
      ok: true,
      value: {
        reports: [
          meta('2026-10-06', 'week', Date.UTC(2026, 9, 6), Date.UTC(2026, 9, 12)),
          meta('2026-09-13', 'day', Date.UTC(2026, 8, 13), Date.UTC(2026, 8, 13, 23, 59, 59, 999)),
          meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999)),
          meta('2026-09', 'month', Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 30, 23, 59, 59, 999)),
        ],
      },
    }),
  })

  assert.deepEqual(panel.calls.map((entry) => entry.payload.endpoint), ['list'])
  assert.deepEqual(plain(panel.calls[0].payload.payload), { limit: 100 })

  const rendered = rows(await panel.render())
  assert.deepEqual(
    rendered.map((row) => row.label),
    ['2026-10-12', '2026-10-06', '2026-09-13', '2026-09'],
    'the newest startTime must come first regardless of store order',
  )
  // Every entry shows its span — the user's "each event needs a time span".
  assert.deepEqual(rendered.map((row) => row.span), [
    '2026-10-12 00:00 ~ 2026-10-12 23:59',
    '2026-10-06 00:00 ~ 2026-10-12 00:00',
    '2026-09-13 00:00 ~ 2026-09-13 23:59',
    '2026-09-01 00:00 ~ 2026-09-30 23:59',
  ])
  assert.deepEqual(rendered.map((row) => row.badge), ['日报', '周报', '日报', '月报'])
  assert.deepEqual(rendered.map((row) => row.status), ['正常', '正常', '正常', '正常'])
})

test('a failed report renders its status and the captured error', async () => {
  const panel = await mount({
    list: async () => ({
      ok: true,
      value: { reports: [meta('2026-10-11', 'day', Date.UTC(2026, 9, 11), Date.UTC(2026, 9, 11, 23, 59, 59, 999), { status: 'failed', error: 'model timeout' })] },
    }),
  })
  const tree = await panel.render()
  assert.equal(rows(tree)[0].status, 'failed')
  assert.match(textOf(tree), /model timeout/u)
})

test('loading, empty and error list states each render their own copy', async () => {
  const loading = await mount({ list: () => new Promise(() => {}) })
  assert.match(textOf(loading.first), /正在读取/u)

  const empty = await mount({ list: async () => ({ ok: true, value: { reports: [] } }) })
  assert.match(textOf(await empty.render()), /还没有生成任何报告/u)

  const refused = await mount({ list: async () => ({ ok: false, error: { code: 'failed', message: 'index missing' } }) })
  assert.match(textOf(await refused.render()), /读取失败：index missing/u)

  const transport = await mount({ list: async () => { throw new Error('socket closed') } })
  assert.match(textOf(await transport.render()), /工作日志服务不可用/u)

  // The host's own unavailable envelope — an unopened report store — reads the
  // same as a transport failure, not as a read error with a raw code.
  const closed = await mount({ list: async () => ({ ok: false, error: { code: 'unavailable', message: 'store closed' } }) })
  assert.match(textOf(await closed.render()), /工作日志服务不可用/u)
})

test('typing issues one debounced hybrid search and renders score with snippet', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999))] } }),
    search: async () => ({
      ok: true,
      value: {
        hits: [
          { key: '2026-10-12', kind: 'day', label: '2026-10-12', startTime: Date.UTC(2026, 9, 12), endTime: Date.UTC(2026, 9, 12, 23, 59, 59, 999), status: 'ok', score: 0.75, snippet: '…面板 改为报告列表…' },
          { key: '2026-10-06', kind: 'week', label: '2026-10-06', startTime: Date.UTC(2026, 9, 6), endTime: Date.UTC(2026, 9, 12), status: 'ok', score: 0.25, snippet: '…search 命中…' },
          { key: '2026-09-13', kind: 'day', label: '2026-09-13', startTime: Date.UTC(2026, 8, 13), endTime: Date.UTC(2026, 8, 13, 23, 59, 59, 999), status: 'ok', score: 0.1, snippet: '' },
        ],
      },
    }),
  })

  const input = find(await panel.render(), (node) => node.type === 'input')
  assert.ok(input, 'the panel must offer a search input')
  input.props.onChange({ target: { value: '面板' } })
  assert.equal(panel.timers.size, 1, 'the first keystroke must be debounced')
  assert.deepEqual(panel.calls.map((entry) => entry.payload.endpoint), ['list'])

  // A second keystroke replaces the pending search rather than queueing one.
  const second = find(await panel.render(), (node) => node.type === 'input')
  second.props.onChange({ target: { value: '面板 搜索' } })
  assert.equal(panel.timers.size, 1, 'only the last keystroke may survive the quiet period')

  await panel.flushTimers()
  const searchCalls = panel.calls.filter((entry) => entry.payload.endpoint === 'search')
  assert.equal(searchCalls.length, 1)
  assert.deepEqual(plain(searchCalls[0].payload.payload), { query: '面板 搜索', mode: 'hybrid', limit: 30 })

  const tree = await panel.render()
  const rendered = rows(tree)
  assert.deepEqual(rendered.map((row) => row.label), ['2026-10-12', '2026-10-06', '2026-09-13'])
  assert.deepEqual(rendered.map((row) => row.score), ['0.75', '0.25', '0.10'])
  const text = textOf(tree)
  assert.match(text, /搜索结果/u)
  assert.match(text, /0\.75/u)
  assert.match(text, /0\.25/u)
  assert.match(text, /面板 改为报告列表/u)
  assert.match(text, /search 命中/u)
  assert.deepEqual(rendered.map((row) => row.span), [
    '2026-10-12 00:00 ~ 2026-10-12 23:59',
    '2026-10-06 00:00 ~ 2026-10-12 00:00',
    '2026-09-13 00:00 ~ 2026-09-13 23:59',
  ])

  // A hit without a snippet renders no snippet element, rather than an empty one.
  assert.deepEqual(rendered.map((row) => row.snippet), ['…面板 改为报告列表…', '…search 命中…', undefined])
})

test('an empty query drops back to the list without searching', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999))] } }),
    search: async () => ({ ok: true, value: { hits: [] } }),
  })

  const input = find(await panel.render(), (node) => node.type === 'input')
  input.props.onChange({ target: { value: '面板' } })
  await panel.flushTimers()
  assert.equal(panel.calls.filter((entry) => entry.payload.endpoint === 'search').length, 1)

  const back = find(await panel.render(), (node) => node.type === 'input')
  back.props.onChange({ target: { value: '' } })
  assert.equal(panel.timers.size, 0, 'clearing the box must cancel the pending search')
  const tree = await panel.render()
  assert.equal(rows(tree).length, 1)
  assert.doesNotMatch(textOf(tree), /搜索结果/u)
  assert.equal(panel.calls.filter((entry) => entry.payload.endpoint === 'search').length, 1)
})

test('a search that matches nothing reports it instead of an empty list', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [] } }),
    search: async () => ({ ok: true, value: { hits: [] } }),
  })
  const input = find(await panel.render(), (node) => node.type === 'input')
  input.props.onChange({ target: { value: '不存在' } })
  await panel.flushTimers()
  assert.match(textOf(await panel.render()), /没有匹配的报告/u)
})

test('a failed search reports the failure rather than the list', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [] } }),
    search: async () => { throw new Error('socket closed') },
  })
  const input = find(await panel.render(), (node) => node.type === 'input')
  input.props.onChange({ target: { value: '面板' } })
  await panel.flushTimers()
  assert.match(textOf(await panel.render()), /工作日志服务不可用/u)
})

test('opening an entry loads the report body and leaving it returns to the list', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999))] } }),
    get: async () => ({
      ok: true,
      value: {
        meta: meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999)),
        body: '# 2026-10-12\n\n- 面板改为报告列表\n- 加了搜索',
      },
    }),
  })
  const row = rows(await panel.render())[0]
  assert.equal(typeof row.onClick, 'function')
  row.onClick()

  const getCalls = panel.calls.filter((entry) => entry.payload.endpoint === 'get')
  assert.equal(getCalls.length, 1)
  assert.deepEqual(plain(getCalls[0].payload.payload), { key: '2026-10-12' })

  const detail = await panel.render()
  const body = find(detail, (node) => node.type === 'pre')
  assert.ok(body, 'the Markdown body must render as text')
  assert.equal(body.children[0], '# 2026-10-12\n\n- 面板改为报告列表\n- 加了搜索')
  assert.match(body.props.className, /wj-body/u)
  assert.match(textOf(detail), /2026-10-12 00:00 ~ 2026-10-12 23:59/u)

  const back = find(detail, (node) => node.type === 'button' && node.children[0] === 'back')
  assert.ok(back, 'the detail view must offer a way back')
  back.props.onClick()
  const listed = await panel.render()
  assert.equal(rows(listed).length, 1, 'going back must restore the list')
  assert.equal(find(listed, (node) => node.type === 'pre'), undefined)
})

test('the detail view distinguishes a missing report, an empty body and a failure', async () => {
  const open = async (responder) => {
    const panel = await mount({
      list: async () => ({ ok: true, value: { reports: [meta('2026-10-12', 'day', Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 12, 23, 59, 59, 999))] } }),
      get: responder,
    })
    rows(await panel.render())[0].onClick()
    return panel.render()
  }

  // The host's not-found envelope, which must read as "gone", not "read failed".
  assert.match(
    textOf(await open(async () => ({ ok: false, error: { code: 'not-found', message: 'no such report' } }))),
    /这份报告已不存在/u,
  )
  // A body the generator left empty is not the same as a missing report.
  assert.match(textOf(await open(async () => ({ ok: true, value: { meta: meta('2026-10-12', 'day', 0, 1), body: '' } }))), /这份报告没有正文/u)
  assert.match(textOf(await open(async () => { throw new Error('socket closed') })), /工作日志服务不可用/u)
  // An unopened store degrades to its own sentence on every endpoint.
  assert.match(
    textOf(await open(async () => ({ ok: false, error: { code: 'unavailable', message: 'store closed' } }))),
    /工作日志服务不可用/u,
  )
})

test('a search hit opens the same detail view', async () => {
  const panel = await mount({
    list: async () => ({ ok: true, value: { reports: [] } }),
    search: async () => ({
      ok: true,
      value: { hits: [{ key: '2026-10-06', kind: 'week', label: '2026-10-06', startTime: Date.UTC(2026, 9, 6), endTime: Date.UTC(2026, 9, 12), status: 'ok', score: 0.5, snippet: '…面板…' }] },
    }),
    get: async () => ({ ok: true, value: { meta: meta('2026-10-06', 'week', Date.UTC(2026, 9, 6), Date.UTC(2026, 9, 12)), body: '周报正文' } }),
  })
  find(await panel.render(), (node) => node.type === 'input').props.onChange({ target: { value: '面板' } })
  await panel.flushTimers()
  rows(await panel.render())[0].onClick()
  const detail = await panel.render()
  assert.equal(find(detail, (node) => node.type === 'pre').children[0], '周报正文')
  assert.deepEqual(plain(panel.calls.filter((entry) => entry.payload.endpoint === 'get')[0].payload.payload), { key: '2026-10-06' })
})

/**
 * The debounce must be cancellable: a keystroke that is cleared — or a panel
 * that unmounts — cannot still fire a search into a dead component.
 */
test('a debounced search is a cancellable single flight', async () => {
  const client = await load()
  const { deferSearch, SEARCH_DELAY } = client.__test
  const pending = new Map()
  let next = 1
  const fired = []
  const queue = deferSearch({
    // A fired timer no longer exists, exactly as the host's setTimeout behaves.
    later(fn, ms) {
      const id = next
      next += 1
      pending.set(id, { ms, fn: () => { pending.delete(id); fn() } })
      return id
    },
    cancel(id) { pending.delete(id) },
  }, () => fired.push('run'))

  queue.schedule(SEARCH_DELAY)
  queue.schedule(SEARCH_DELAY)
  assert.equal(pending.size, 1, 'a new keystroke replaces the pending search')
  const [timer] = pending.values()
  assert.equal(timer.ms, SEARCH_DELAY)
  timer.fn()
  assert.deepEqual(fired, ['run'])
  assert.equal(pending.size, 0)

  queue.schedule(SEARCH_DELAY)
  queue.cancel()
  assert.equal(pending.size, 0, 'clearing the box must drop the pending search')
  assert.deepEqual(fired, ['run'])
})

test('the mount effect does not re-fetch on every render, and unmount aborts', async () => {
  const signals = []
  const panel = await mount({
    list: async (_payload, signal) => {
      signals.push(signal)
      return { ok: true, value: { reports: [] } }
    },
  })
  assert.equal(signals.length, 1, 'mounting must issue exactly one list request')
  await panel.render()
  await panel.render()
  assert.equal(signals.length, 1, 'a re-render must not re-issue the list request')

  // The only effect that returns a cleanup is the unmount teardown; running it
  // is what a panel teardown does.
  assert.equal(panel.cleanups.length, 1, 'the panel must register exactly one unmount cleanup')
  panel.cleanups[0]()
  assert.equal(signals[0].aborted, true, 'unmounting must abort the in-flight list request')
})

test('the panel stylesheet is scoped to this plugin so unload removes it', async () => {
  const styles = []
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true } }),
    head: { append(style) { styles.push(style) } },
  }
  const client = await load({ document })
  const { ctx, recorded } = harness()
  client.apply(ctx)
  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, '@yiln-dsh/dsh-plugins')
  assert.match(styles[0].textContent, /\.wj-panel/u)
  // The Markdown body must be plain text with preserved whitespace — no
  // Markdown library is bundled, and `pre` is what keeps the layout readable.
  assert.match(styles[0].textContent, /\.wj-body\{[^}]*white-space:pre-wrap/u)
  for (const effect of recorded.effects) effect.dispose()
  assert.equal(styles[0].removed, true)
})
