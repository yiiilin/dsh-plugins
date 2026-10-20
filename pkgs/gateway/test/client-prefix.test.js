/**
 * The gateway panel's requests stay inside the environment prefix they are served
 * from.
 *
 * The panel runs under `/main/` (or `/env-<id>/`) while the daemon's admin API is
 * addressed through the same page, so every request it makes has to resolve
 * against the page's own base — not the origin root. A root-absolute path escapes
 * the prefix, lands on the prefix-less route, and is answered with the login page
 * instead of JSON; the client then reports the panel as unreachable and says
 * nothing else, which is why the defect is worth a behavioural test rather than a
 * note.
 *
 * The bundle is executed in a `node:vm` context with a `document.baseURI` and a
 * recording `fetch`, the same way `pkgs/desktop-vnc/test/client.test.js` runs its
 * client half. The assertion is exact URL equality: a suffix match such as
 * `/\/admin\/state$/` would also pass for the root-absolute URL that is the bug.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_PATH = fileURLToPath(new URL('../client.js', import.meta.url))
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8')

/** The mount a main node serves its own harness under. */
const MAIN_PREFIX_BASE = 'http://127.0.0.1:3080/main/'
/** A federated environment's mount. */
const ENVIRONMENT_BASE = 'http://127.0.0.1:3080/env-6-13/'
/** An edge serves its harness at the origin root. */
const ROOT_BASE = 'http://127.0.0.1:3080/'

/** Enough of React for the bundle to load: the panel is never rendered here. */
const REACT_STUB = new Proxy({}, {
  get: (_target, name) => (name === 'Fragment' ? 'fragment' : () => null),
})

/**
 * A `fetch` that records what it was asked for and answers with a fixed body.
 *
 * @param body - the response text, so a test can also drive the parse-failure path.
 * @returns the stub and the requests it observed.
 */
function recordingFetch(body = JSON.stringify({ ok: true })) {
  const requests = []
  const fetch = async (input, options) => {
    requests.push({
      url: input instanceof URL ? input.href : String(input),
      options: options ?? {},
    })
    return {
      status: 200,
      text: async () => body,
    }
  }
  return { fetch, requests }
}

/**
 * Execute the shipped bundle and return its factory exports.
 *
 * @param options - the page base the bundle resolves against, and its `fetch`.
 * @returns the object the factory returned.
 */
function loadClient({ baseURI, fetch }) {
  let entry = null
  const window = { __ModuleLoader__: { load(spec) { entry = spec } } }
  const sandbox = {
    // Browser globals the bundle resolves its requests against.
    URL,
    document: { baseURI },
    fetch,
    window,
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 })
  assert.notEqual(entry, null, 'the bundle must register with window.__ModuleLoader__')
  assert.equal(typeof entry.factory, 'function', 'the registration must carry a factory')
  return entry.factory((name) => {
    if (name === 'react') return REACT_STUB
    throw new Error(`unexpected client require: ${name}`)
  })
}

/**
 * The six requests the panel makes, in the shapes its call sites build them.
 *
 * Two of the six are `GET /admin/state` — the panel page and the sidebar switcher —
 * so there are four distinct paths behind six call sites. Every one of them used to
 * be root-absolute.
 */
const PANEL_REQUESTS = [
  {
    callSite: 'panel load',
    path: '/admin/state',
    options: undefined,
    expected: 'http://127.0.0.1:3080/main/admin/state',
  },
  {
    callSite: 'create environment',
    path: '/admin/environments',
    options: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: '6.13' }) },
    expected: 'http://127.0.0.1:3080/main/admin/environments',
  },
  {
    callSite: 'rename environment',
    path: '/admin/environments/edge1',
    options: { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'renamed' }) },
    expected: 'http://127.0.0.1:3080/main/admin/environments/edge1',
  },
  {
    callSite: 'remove environment',
    path: '/admin/environments/edge1',
    options: { method: 'DELETE' },
    expected: 'http://127.0.0.1:3080/main/admin/environments/edge1',
  },
  {
    callSite: 'rotate environment token',
    path: '/admin/environments/edge1/token',
    options: { method: 'POST' },
    expected: 'http://127.0.0.1:3080/main/admin/environments/edge1/token',
  },
  {
    callSite: 'sidebar switcher',
    path: '/admin/state',
    options: undefined,
    expected: 'http://127.0.0.1:3080/main/admin/state',
  },
]

test('every panel request resolves inside the prefix the page is served from', async () => {
  // The whole defect in one table: under `/main/`, each request must land on
  // `/main/admin/…`. The exact string is asserted, so a root-absolute URL — which is
  // what the panel used to send, and what a suffix match would still accept — fails.
  for (const { callSite, path, options, expected } of PANEL_REQUESTS) {
    const { fetch, requests } = recordingFetch()
    const { __test } = loadClient({ baseURI: MAIN_PREFIX_BASE, fetch })

    await __test.call(path, options)

    assert.equal(requests.length, 1, `${callSite}: exactly one request`)
    assert.equal(requests[0].url, expected, `${callSite}: ${path} must stay inside the prefix`)
    assert.notEqual(
      requests[0].url,
      expected.replace('/main', ''),
      `${callSite}: the request must not escape to the origin root`,
    )
  }
})

test('the request options and the same-origin credential survive the resolution', async () => {
  // Resolving the path must not quietly drop what the call site asked for: a POST
  // without its body or a request without the cookie is a different request.
  const { fetch, requests } = recordingFetch()
  const { __test } = loadClient({ baseURI: MAIN_PREFIX_BASE, fetch })

  await __test.call('/admin/environments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '6.13' }),
  })

  const [request] = requests
  assert.equal(request.options.credentials, 'same-origin', 'the session cookie travels with the request')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers['content-type'], 'application/json')
  assert.equal(request.options.body, JSON.stringify({ label: '6.13' }))
})

test('the same paths resolve inside a federated environment prefix', async () => {
  // `/env-6-13/` is the other deployment shape, and the reason the resolution has to
  // be relative rather than a hard-coded `/main/`.
  const { fetch, requests } = recordingFetch()
  const { __test } = loadClient({ baseURI: ENVIRONMENT_BASE, fetch })

  await __test.call('/admin/state')

  assert.equal(requests[0].url, 'http://127.0.0.1:3080/env-6-13/admin/state')
})

test('at the origin root the same paths stay where they were', async () => {
  // An edge serves its harness at `/`, so the fix must not move its requests
  // anywhere: relative resolution against the root is the root.
  const { fetch, requests } = recordingFetch()
  const { __test } = loadClient({ baseURI: ROOT_BASE, fetch })

  await __test.call('/admin/state')

  assert.equal(requests[0].url, 'http://127.0.0.1:3080/admin/state')
})

test('a page reached at a deeper path resolves against its mount, not that path', async () => {
  // `document.baseURI` is the document's own base, which for a harness page is the
  // mount root; the resolution must use it as given rather than deriving a
  // directory from `location`.
  const { fetch, requests } = recordingFetch()
  const { __test } = loadClient({ baseURI: 'http://127.0.0.1:3080/main/index.html', fetch })

  await __test.call('/admin/state')

  assert.equal(requests[0].url, 'http://127.0.0.1:3080/main/admin/state')
})

test('a JSON answer is parsed and an unparseable one is reported, not thrown', async () => {
  // The failure this defect produced: the login page arrives as HTML with status
  // 200, the parse fails, and the panel shows "unreachable". The helper's contract
  // is to report that rather than raise, so the panel's own state machine can show
  // it — this test pins that contract, not the bug.
  // The objects come from the sandbox's realm, so they are read member by member:
  // `deepEqual` would compare prototypes across realms.
  const ok = loadClient({ baseURI: MAIN_PREFIX_BASE, fetch: recordingFetch(JSON.stringify({ ok: true, environments: [] })).fetch })
  const parsed = await ok.__test.call('/admin/state')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.environments.length, 0)

  const html = loadClient({ baseURI: MAIN_PREFIX_BASE, fetch: recordingFetch('<!doctype html><title>login</title>').fetch })
  const result = await html.__test.call('/admin/state')
  assert.equal(result.ok, false, 'an HTML answer is not treated as success')
  assert.match(result.error, /^HTTP 200: <!doctype html>/u, 'and the status and body are reported')
})
