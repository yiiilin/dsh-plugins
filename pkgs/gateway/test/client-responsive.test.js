/**
 * The gateway panel's narrow-width rules, and the promise that the desktop layout
 * is untouched.
 *
 * The panel's measurements are inline styles copied from Plugin Market's stylesheet.
 * An inline style outranks every stylesheet rule, so the narrow layout can only be
 * an override — which is exactly why it is worth a test rather than a note: one
 * unqualified rule in the new sheet would silently change the desktop panel that
 * those numbers were chosen for.
 *
 * Two kinds of assertion are used, deliberately:
 *
 * - Behavioural, through the bundle: `apply()` mounts the sheet, its disposer
 *   removes it, and the rendered grid keeps its inline two-column value.
 * - Structural, over the sheet's text: everything the sheet declares lives inside a
 *   query, the only `!important` sits inside a query, and the client never measures
 *   the window in JavaScript. Those are properties of the source, and reading the
 *   source is the only way to assert that no rule ever applies unconditionally.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')
const BASE = 'http://127.0.0.1:3080/main/'

/** Enough React for `apply()` to register, and for the switcher to render once. */
function reactStub() {
  return {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useState: (value) => [value, () => {}],
    // Runs the effect once, synchronously, so a mount's request is observable.
    useEffect: (fn) => { fn() },
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
  }
}

/**
 * Execute the bundle with a recording document.
 *
 * @returns the exports and the style elements the plugin mounted.
 */
function loadClient({ fetch = async () => ({ status: 200, text: async () => '{}' }) } = {}) {
  const mounted = []
  let entry = null
  const makeElement = () => ({
    style: {},
    dataset: {},
    attributes: {},
    id: '',
    textContent: '',
    setAttribute(name, value) { this.attributes[name] = value },
    remove() {
      const index = mounted.indexOf(this)
      if (index !== -1) mounted.splice(index, 1)
    },
  })
  const document = {
    baseURI: BASE,
    createElement: () => makeElement(),
    getElementById: (id) => mounted.find((element) => element.id === id) ?? null,
    head: {
      append(element) {
        mounted.push(element)
        // A real <style> is in the document from this point on, which is what the
        // idempotence check reads.
        if (element.id === '') element.id = element.attributes.id ?? ''
      },
    },
  }
  const window = { __ModuleLoader__: { load(spec) { entry = spec } } }
  const sandbox = { URL, document, fetch, window }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 })
  assert.notEqual(entry, null, 'the bundle must register with window.__ModuleLoader__')

  const exported = entry.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`unexpected client require: ${name}`)
  })
  return { exported, mounted }
}

/** Mount the plugin and return the disposers `apply` produced. */
function applyPlugin(exported, { mounted }) {
  const disposers = []
  const registered = []
  const slots = {
    inject: (_name, callback) => { callback(); return () => {} },
    register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {} },
  }
  const locale = { register: () => () => {}, bind: () => (key) => exported.__test.ZH[key] ?? key }
  const ctx = {
    locale,
    slots,
    get: (name) => ({ locale, slots })[name],
    effect(callback) {
      const dispose = callback()
      assert.equal(typeof dispose, 'function', 'apply must register cleanable effects')
      disposers.push(dispose)
      return dispose
    },
  }
  exported.apply(ctx)
  return { disposers, registered, mounted }
}

/** Split a stylesheet into its top-level blocks, so nesting can be inspected. */
function topLevelBlocks(css) {
  const blocks = []
  let depth = 0
  let start = -1
  let prelude = 0
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') {
      if (depth === 0) {
        // The block's text starts at its selector/prelude, which begins after the
        // previous block ended and any comment it left behind.
        start = prelude
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) blocks.push(css.slice(start, index + 1).trim())
      prelude = index + 1
    }
  }
  assert.equal(depth, 0, 'the stylesheet must be balanced')
  return blocks
}

/** Drop block comments, so a selector is what a block actually starts with. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').trim()

test('the narrowed sheet is mounted through ctx.effect and removed when it is disposed', () => {
  const client = loadClient()
  const { disposers, mounted } = applyPlugin(client.exported, client)

  const sheet = mounted.find((element) => element.attributes['data-plugin'] !== undefined)
  assert.notEqual(sheet, undefined, 'the panel must mount its narrow-width sheet')
  assert.equal(sheet.attributes['data-plugin'], '@yiln-dsh/dsh-plugins', 'the sheet declares the suite, as the other packages do')
  assert.equal(sheet.id, client.exported.__test.STYLE_ID, 'the sheet carries the id the idempotence check looks for')
  assert.ok(sheet.textContent.includes('@container'), 'the narrow rules are keyed to the panel, not the window')

  // Disposing the plugin must take the sheet with it, or a hot reload would stack
  // copies and the last one to mount would win for every panel.
  for (const dispose of disposers) dispose()
  assert.equal(mounted.length, 0, 'disposing the plugin removes its sheet')
})

test('every rule in the sheet sits inside a query, and the sheet is written once', () => {
  const client = loadClient()
  const css = client.exported.__test.NARROW_CSS
  const blocks = topLevelBlocks(css)
  assert.ok(blocks.length > 0, 'the sheet is not empty')

  // THE GUARD FOR "THE DESKTOP DOES NOT MOVE": a rule at the top level of the sheet
  // applies at every width, including the 968px desktop panel these numbers were
  // drawn for. Each block must therefore be a query.
  for (const block of blocks) {
    assert.match(stripComments(block), /^@(container|media)\b/u,
      `a top-level rule would change the desktop panel: ${stripComments(block).slice(0, 90)}`)
  }

  // The container query is the narrow-layout one, and it is the width the panel's
  // design source collapses at.
  const container = blocks.find((block) => stripComments(block).startsWith('@container'))
  assert.notEqual(container, undefined, 'the panel needs a width-keyed block')
  assert.match(container, /@container \(width <= 680px\)/u, 'keyed to the panel width the design source uses')
  assert.match(container, /\.dsg-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
    'the environment grid collapses to one column')
  // The table keeps its horizontal scroll; only the page behind it is held still.
  assert.match(container, /\.dsg-tablebox\s*\{[^}]*overscroll-behavior-x:\s*contain/u,
    'a horizontal flick must not drag the page')

  // iOS zooms a focused input under 16px, which leaves the panel scrolled sideways.
  // Gated on a coarse pointer, so a narrow desktop window keeps the 12px control.
  const media = blocks.find((block) => stripComments(block).startsWith('@media'))
  assert.notEqual(media, undefined, 'touch devices need their own block')
  assert.match(media, /@media \(max-width: 680px\) and \(pointer: coarse\)/u, 'the input-size fix is for touch only')
  assert.match(media, /\.dsg-input\s*\{[^}]*font-size:\s*16px/u, 'iOS must not zoom the credential fields')
})

test('the only !important in the sheet is the one that has to beat an inline style', () => {
  const client = loadClient()
  const css = client.exported.__test.NARROW_CSS
  const important = [...css.matchAll(/[^;{}]*!important/gu)].map((match) => match[0].trim())
  assert.equal(important.length, 1,
    `exactly one declaration may outrank the inline baseline, found: ${important.join(' | ')}`)
  assert.match(important[0], /^grid-template-columns:/u, 'only the grid column count needs to override an inline value')

  // And it must be inside the container query, never reachable by a wide panel.
  const container = topLevelBlocks(css).find((block) => stripComments(block).startsWith('@container'))
  assert.notEqual(container, undefined, 'the override must have a container query to live in')
  assert.ok(container.includes('!important'), 'the override lives inside the width query')
  const outside = css.replace(container, '')
  assert.equal(outside.includes('!important'), false, 'no override may sit outside the width query')
})

test('the desktop grid keeps its inline value, and the client never measures the window', () => {
  const client = loadClient()

  // Source-level, because "we did not read the window" cannot be observed through a
  // render: any of these would reintroduce resize-driven layout jitter.
  for (const pattern of [/matchMedia\s*\(/u, /\binnerWidth\b/u, /\bclientWidth\b/u, /getBoundingClientRect\s*\(/u]) {
    assert.equal(pattern.test(CLIENT_SOURCE), false, `the panel must not measure the window: ${pattern}`)
  }

  // The narrow rules are CSS, and the class hooks they need are on the markup.
  for (const name of ['dsg-grid', 'dsg-head', 'dsg-wrap', 'dsg-tablebox', 'dsg-input', 'dsg-cardrow', 'dsg-cardname']) {
    assert.ok(CLIENT_SOURCE.includes(`'${name}'`), `the sheet styles .${name} but nothing carries it`)
  }

  // The desktop numbers themselves are untouched: this change adds a sheet, it does
  // not re-measure the panel. These are the values the design source specifies.
  assert.ok(CLIENT_SOURCE.includes('maxWidth: 968'), 'the panel keeps its 968px content width')
  assert.ok(CLIENT_SOURCE.includes("gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'"),
    'the desktop grid keeps two columns inline')
  assert.ok(CLIENT_SOURCE.includes("paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))'"),
    'the frame-top clearance is unchanged')
  assert.ok(CLIENT_SOURCE.includes("containerType: 'inline-size'"),
    'the panel stays its own query container, which is what the narrow query measures')
})

test('the environment switcher is withdrawn in the collapsed sidebar', () => {
  // The panel's `call` resolves against `document.baseURI`, so the requests a mount
  // makes are observable. Effects run synchronously here: that is what turns
  // "the rail asks for nothing" into something a test can see.
  const requests = []
  const client = loadClient({
    fetch: async (input) => {
      requests.push(input instanceof URL ? input.href : String(input))
      return { status: 200, text: async () => JSON.stringify({ ok: true, self: {}, manages: true, environments: [] }) }
    },
  })
  const { makeSwitcher, ZH } = client.exported.__test
  const t = (key) => ZH[key] ?? key
  const Switcher = makeSwitcher(t)

  // `wide: false` is the 56px icon rail: a `nowrap` label plus a select that will
  // not shrink below its text would push the whole column out. It renders nothing.
  const rail = Switcher({ wide: false })
  assert.equal(rail, null, 'a label and a select cannot fit a 56px rail')
  // And it asks the daemon for nothing either: the guard sits inside the effect, so
  // collapsing a sidebar does not leave a request behind it.
  assert.deepEqual(requests, [], 'the collapsed rail must not fetch the environment list')

  // The wide column does ask — that is how the component fills its options.
  assert.equal(typeof Switcher, 'function')
  Switcher({ wide: true })
  assert.equal(requests.length, 1, 'the wide switcher loads the environment list on mount')
  assert.equal(requests[0], `${BASE}admin/state`, 'read under the mount the panel is served from')
})
