/**
 * The login page's PWA assets are actually served, and served where it says.
 *
 * Every assertion goes through a real socket against a mounted daemon: what matters
 * is the answer a browser gets for the URL the page declared, not how the module is
 * written. The failure this replaces was silent — an unauthenticated
 * `GET /manifest.webmanifest` used to be answered with the login page itself, which a
 * browser parses as a manifest and then discards without a word.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'

/** A cheap work factor: a record per mount, fast enough for a test. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** The credential the seeded record stands for; nothing signs in with it here. */
const CREDENTIAL = 'pairing credential 7b2e'

/** A temporary DSH home; the production path is never touched. */
async function temporaryHome() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-pwa-'))
}

/** Seed `daemon/auth/pairing.json`, which is now the only source of the credential. */
async function seedCredential(home) {
  const directory = join(home, 'daemon', 'auth')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const salt = randomBytes(16)
  const hash = scryptSync(CREDENTIAL, salt, CHEAP.keylen, { ...CHEAP, maxmem: 64 * 1024 * 1024 })
  await writeFile(join(directory, PAIRING_CREDENTIAL_FILE), `${JSON.stringify({
    version: 1,
    credential: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      ...CHEAP,
      createdAt: 1_600_000_000_000,
    },
  })}\n`, { mode: 0o600 })
}

/**
 * Mount the daemon and wait until it is listening, then answer with its origin.
 *
 * The listener is started by the plugin's own effect, so the effect has to run for
 * this to be a real request rather than a hand-built one. The bound port is ephemeral
 * and only the daemon's own startup line knows it, which is why the logger is watched.
 */
async function startDaemon(home, config = {}) {
  let announce
  const listening = new Promise((done) => { announce = done })
  const disposers = []
  const ctx = {
    logger: {
      info: (message) => {
        const match = /listening on .*:(\d+)$/u.exec(message)
        if (match !== null) announce(Number(match[1]))
        return true
      },
      warn: () => true,
    },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on: () => () => {},
  }
  apply(ctx, {
    homeDir: home,
    registryPath: join(home, 'daemon', 'environments.json'),
    cacheDir: join(home, 'daemon', 'cache'),
    host: '127.0.0.1',
    port: 0,
    rootEmbedded: false,
    systemdUnit: '',
    role: 'main',
    profile: '',
    ...config,
  })
  const port = await listening
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const dispose of disposers) await dispose()
    },
  }
}

/** Run `body` against a freshly mounted daemon and always tear it down. */
async function withDaemon(config, body) {
  const home = await temporaryHome()
  await seedCredential(home)
  const daemon = await startDaemon(home, config)
  try {
    return await body(daemon)
  } finally {
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** Every URL the page declares as an asset, as a browser would read them. */
function declaredAssets(html) {
  const manifest = /<link[^>]+rel="manifest"[^>]+href="([^"]+)"/u.exec(html)
  const icon = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/u.exec(html)
  const appleTouch = /<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/u.exec(html)
  return {
    manifest: manifest?.[1],
    icon: icon?.[1],
    appleTouch: appleTouch?.[1],
  }
}

/** The worker registration the page performs: script URL and the scope it asks for. */
function declaredWorker(html) {
  const match = /serviceWorker\.register\("([^"]+)",\s*\{\s*scope:\s*"([^"]+)"/u.exec(html)
  return match === null ? undefined : { script: match[1], scope: match[2] }
}

// --- reachable without a session ---------------------------------------------

test('a browser with no session is served the manifest, not the login page', async () => {
  // The whole point of the route: the login page is the only thing an unpaired
  // browser can reach, and it declares a manifest. Answering that declaration with
  // the page's own HTML is the failure this test exists for.
  await withDaemon({}, async ({ origin }) => {
    const response = await fetch(`${origin}/manifest.webmanifest`)
    assert.equal(response.status, 200, 'the manifest is public')
    assert.match(
      String(response.headers.get('content-type')),
      /^application\/manifest\+json/u,
      `expected a manifest content type, got ${response.headers.get('content-type')}`,
    )

    const text = await response.text()
    assert.doesNotMatch(text, /<!doctype html>/iu, 'the login page was not answered as the manifest')
    const manifest = JSON.parse(text)
    assert.equal(manifest.name, 'DeepSeek Harness')
    assert.equal(manifest.start_url, '/', 'at the origin root the app starts at the root')
    assert.equal(manifest.scope, '/')
    assert.deepEqual(manifest.icons.map((icon) => icon.src), ['/icons/icon-192.png', '/icons/icon-512.png'])
  })
})

test('a browser with no session is served the service worker as JavaScript', async () => {
  // A worker is fetched with a script content type; HTML here is the same silent
  // failure as the manifest, because registration simply rejects.
  await withDaemon({}, async ({ origin }) => {
    const response = await fetch(`${origin}/sw.js`)
    assert.equal(response.status, 200, 'the worker is public')
    assert.match(
      String(response.headers.get('content-type')),
      /^application\/javascript/u,
      `expected a JavaScript content type, got ${response.headers.get('content-type')}`,
    )
    const text = await response.text()
    assert.ok(text.length > 0, 'the worker is not empty')
    assert.doesNotMatch(text, /<!doctype html>/iu, 'the login page was not answered as the worker')
  })
})

// --- the page and the routes agree, under a prefix ---------------------------

test('under a prefix every asset the login page declares is what the daemon serves', async () => {
  // The page is served at whatever path the visitor asked for, so a relative URL
  // would resolve against that path. What is asserted here is the contract: take the
  // URL out of the rendered document and request it.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const page = await fetch(`${origin}/some/deep/path`)
    assert.equal(page.status, 200)
    assert.match(String(page.headers.get('content-type')), /^text\/html/u, 'a visitor without a session gets the page')
    const html = await page.text()

    const declared = declaredAssets(html)
    assert.ok(declared.manifest !== undefined, 'the page declares a manifest')
    assert.ok(declared.icon !== undefined, 'the page declares an icon')
    assert.ok(declared.appleTouch !== undefined, 'the page declares an apple-touch icon')

    for (const [name, href] of Object.entries(declared)) {
      assert.ok(href.startsWith('/main/'), `${name}: expected a prefix-absolute URL, got ${href}`)
      const asset = await fetch(`${origin}${href}`)
      assert.equal(asset.status, 200, `${name}: ${href} must be served`)
      assert.doesNotMatch(
        String(asset.headers.get('content-type')),
        /^text\/html/u,
        `${name}: ${href} was answered with the login page`,
      )
    }

    const manifest = await (await fetch(`${origin}${declared.manifest}`)).json()
    assert.equal(manifest.scope, '/main/', 'the manifest scopes itself to the mount, not the origin')
    assert.equal(manifest.start_url, '/main/')
    for (const icon of manifest.icons) {
      assert.ok(icon.src.startsWith('/main/'), `manifest icon ${icon.src} must stay inside the mount`)
      assert.equal((await fetch(`${origin}${icon.src}`)).status, 200, `manifest icon ${icon.src} must be served`)
    }

    // The route is the prefix one and nothing else: the root-absolute path the old
    // page declared is not a manifest, which is what proves both sides read the same
    // prefix rather than two independent guesses.
    const unprefixed = await fetch(`${origin}/manifest.webmanifest`)
    assert.match(
      String(unprefixed.headers.get('content-type')),
      /^text\/html/u,
      'an unprefixed path is not the manifest under a prefix',
    )
  })
})

test('under a prefix the worker is registered where it is served, with a matching scope', async () => {
  // A scope may not exceed the worker's own directory: `/sw.js` with scope `/main/`
  // is a SecurityError, and scope `/` would let the login page's worker intercept
  // every other mount on the origin. Script URL and scope therefore come from the
  // same prefix, and both must actually answer.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const html = await (await fetch(`${origin}/`)).text()
    const worker = declaredWorker(html)
    assert.ok(worker !== undefined, 'the page registers a service worker')

    assert.equal(worker.script, '/main/sw.js', 'the script is served under the prefix')
    assert.equal(worker.scope, '/main/', 'the scope is the prefix, and no wider than the script')
    assert.ok(
      worker.script.startsWith(worker.scope),
      `the script ${worker.script} must live inside its scope ${worker.scope}`,
    )

    const script = await fetch(`${origin}${worker.script}`)
    assert.equal(script.status, 200, 'the registered script is served')
    assert.match(String(script.headers.get('content-type')), /^application\/javascript/u)
  })
})

test('the page no longer points at an asset nothing serves', async () => {
  // The old page linked `/favicon.svg`, which was in no asset table and reached no
  // route. Rather than add an asset, the declaration now names the icon the manifest
  // already ships, so the page's references are exactly the ones the daemon answers.
  await withDaemon({}, async ({ origin }) => {
    const html = await (await fetch(`${origin}/`)).text()
    const declared = declaredAssets(html)
    for (const [name, href] of Object.entries(declared)) {
      const asset = await fetch(`${origin}${href}`)
      assert.equal(asset.status, 200, `${name}: ${href} must be served`)
    }
    assert.equal(declared.icon, '/icons/icon-192.png', 'the icon is the one the manifest ships')
    assert.doesNotMatch(html, /favicon\.svg/u, 'no declaration points at an asset the daemon does not serve')
  })
})
