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
  for (const key of ['title', 'guide.description', 'range.day', 'range.week', 'range.month', 'copy', 'empty', 'unavailable']) {
    assert.ok(zh[key], `zh is missing ${key}`)
    assert.ok(en[key], `en is missing ${key}`)
  }
  assert.notEqual(zh.title, en.title)

  assert.equal(recorded.tabs.length, 1)
  const tab = recorded.tabs[0]
  assert.equal(tab.kind, 'work-journal.journal')
  assert.equal(tab.priority, 'extension')
  assert.equal(tab.title(), 'title')
  assert.equal(tab.guide.length, 1)
  assert.equal(tab.guide[0].id, 'work-journal')
  assert.equal(typeof tab.guide[0].icon, 'function')

  // The body registers under the type's own id in the product's pane seat.
  assert.equal(recorded.slots.length, 1)
  assert.equal(recorded.slots[0].options.name, 'sidebar.right.pane.tab')
  assert.equal(recorded.slots[0].options.key, tab.id)
  assert.equal(typeof recorded.slots[0].component, 'function')
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
  await assert.rejects(() => failure.query({ range: 'day' }), (error) => error.code === 'unavailable')

  const refused = client.__test.createClient({ call: async () => ({ ok: false, error: { code: 'failed', message: 'index missing' } }) })
  await assert.rejects(() => refused.query({ range: 'day' }), (error) => error.code === 'failed' && /index missing/u.test(error.message))

  const ok = client.__test.createClient({ call: async (_channel, endpoint) => ({ ok: true, value: { endpoint } }) })
  assert.deepEqual(await ok.query({ range: 'day' }), { endpoint: 'query' })
})

test('the panel client posts to the plugin channel with the requested range', async () => {
  const calls = []
  const client = client0(await load(), calls)
  await client.query({ range: 'month', refresh: true })
  assert.equal(calls[0].channel, '/work-journal')
  assert.equal(calls[0].endpoint, 'query')
  assert.deepEqual(calls[0].payload, { range: 'month', refresh: true })
})

/** Build a client whose RPC calls are recorded. */
function client0(module, calls) {
  return module.__test.createClient({
    call: async (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, payload })
      return { ok: true, value: {} }
    },
  })
}

test('formats durations and integers in the active language', async () => {
  const client = await load()
  const { formatInt, formatDuration } = client.__test
  assert.equal(formatInt(12345), '12,345')
  const zh = (key) => ({ hours: '小时', minutes: '分', lessThanMinute: '不足 1 分钟' })[key]
  assert.equal(formatDuration(0, zh), '不足 1 分钟')
  assert.equal(formatDuration(90 * 60000, zh), '1小时 30分')
})

test('the panel-side project filter mirrors the host aggregation', async () => {
  const client = await load()
  const report = {
    projects: [
      { project: 'alpha', tools: { edit: 2 }, files: { '/w/alpha/a.js': 2 }, commands: { 'alpha-cmd': 1 } },
      { project: 'beta', tools: { read: 5 }, files: { '/w/beta/b.js': 5 }, commands: { 'beta-cmd': 1 } },
    ],
    sessions: [
      { id: 'a', project: 'alpha', days: ['2026-09-13'] },
      { id: 'b', project: 'beta', days: ['2026-09-13'] },
    ],
    days: [{ date: '2026-09-13', sessions: 2 }],
    prompts: [{ sessionId: 'a', text: 'alpha work' }, { sessionId: 'b', text: 'beta work' }],
    tools: [],
    files: [],
  }
  const filtered = client.__test.filterReport(report, 'beta')
  assert.deepEqual(filtered.projects.map((entry) => entry.project), ['beta'])
  assert.deepEqual(filtered.sessions.map((entry) => entry.id), ['b'])
  assert.deepEqual(filtered.prompts.map((entry) => entry.text), ['beta work'])
  assert.equal(filtered.days[0].sessions, 1)
  assert.equal(filtered.tools[0].name, 'read')
  assert.equal(filtered.files[0].path, '/w/beta/b.js')
  // Commands are project-attributed, so filtering cannot leak another
  // project's shell history into the panel.
  // The bundle runs in a VM realm, so compare plain JSON rather than prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(filtered.commands.map((entry) => entry.command))), ['beta-cmd'])
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
  for (const effect of recorded.effects) effect.dispose()
  assert.equal(styles[0].removed, true)
})
