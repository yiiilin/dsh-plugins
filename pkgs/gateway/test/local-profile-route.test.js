import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'

import { startEntry } from '../lib/entry.js'

/**
 * A stand-in for a local profile's harness.
 *
 * It records what reached it and answers the way `dsh web` would: an HTML page, a
 * `dsh-auth-…` cookie scoped to `Path=/`, and a redirect that must not escape its
 * prefix. Those three are exactly what the proxy has to rewrite.
 */
async function fakeHarness() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie })
    if (req.url === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['dsh-auth-deadbeef=secret; Path=/; HttpOnly'],
      })
      res.end('<!doctype html><base href="./"><title>local profile</title>')
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/elsewhere' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, url: req.url, cookie: req.headers.cookie ?? null }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** Start a daemon entry with one local environment behind it. */
async function withEntry({ upstream, id = 'review', ensure, failure } = {}) {
  const requests = []
  const entry = startEntry({
    host: '127.0.0.1',
    port: 0,
    listEnvironments: () => [{ id }],
    local: async (req, res, url) => {
      requests.push(url)
      // Everything that is not the daemon's own is routed.
      return false
    },
    root: undefined,
    tunnel: undefined,
    localProfile: (wanted) => {
      if (wanted !== id) return undefined
      return {
        port: () => upstream.port,
        cookie: () => 'dsh-auth-deadbeef=secret',
        refresh: () => {},
        ensure: ensure ?? (async () => {
          if (failure !== undefined) throw new Error(failure)
          return { profile: id, port: upstream.port, url: '', token: '' }
        }),
      }
    },
    notFound: (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    },
  })
  const bound = await entry
  return { entry: bound, requests }
}

test('a local environment is proxied under its own prefix', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/review/`)
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /local profile/, 'the profile’s own page is what the browser gets')
    // The upstream sees the daemon's loopback authority, not the browser's.
    assert.equal(upstream.seen[0].host, `127.0.0.1:${upstream.port}`)
    assert.equal(upstream.seen[0].url, '/', 'the prefix is stripped before forwarding')
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('the profile cookie is scoped to the prefix so environments do not share it', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/review/`)
    const cookie = response.headers.getSetCookie().join('\n')

    assert.match(cookie, /dsh-auth-deadbeef=secret/)
    assert.match(cookie, /Path=\/review\//u, 'an unscoped Path=/ would reach every environment')
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('an origin-absolute redirect cannot escape the prefix', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/review/redirect`, { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/review/elsewhere')
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('the daemon’s own cookie is replaced, not forwarded', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    await fetch(`http://127.0.0.1:${entry.port}/review/api/x`, {
      headers: { cookie: 'dsh-auth-someoneelse=other' },
    })
    assert.equal(upstream.seen[0].cookie, 'dsh-auth-deadbeef=secret')
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('a profile that cannot start answers 503 with its reason, not a 404', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream, failure: 'no free port in localProfilePortRange' })
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/review/`)
    const body = await response.text()

    assert.equal(response.status, 503)
    assert.match(body, /启动失败/)
    assert.match(body, /no free port/u, 'the operator needs the reason')
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('an id that is not a local environment falls through to 404', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/unknown/x`)
    assert.equal(response.status, 404)
  } finally {
    await entry.close()
    await upstream.close()
  }
})

test('the mux WebSocket is proxied to the local profile', async () => {
  const upstream = await fakeHarness()
  const { entry } = await withEntry({ upstream })
  try {
    // A raw upgrade: the proxy must rewrite Host and keep the connection open.
    const socket = connect(entry.port, '127.0.0.1')
    const answer = await new Promise((resolve, reject) => {
      socket.once('connect', () => {
        socket.write(
          'GET /review/api/remote.mux HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${entry.port}\r\n`
          + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        )
      })
      socket.once('data', (chunk) => resolve(String(chunk).split('\r\n')[0]))
      socket.once('error', reject)
      setTimeout(() => reject(new Error('no upgrade answer')), 3_000)
    })
    socket.destroy()
    // The fake harness is plain HTTP and answers 200/400 rather than switching
    // protocols; what matters is that the request arrived at the profile at all.
    assert.match(answer, /^HTTP\/1\.1 \d{3}/u)
    assert.ok(
      upstream.seen.some((request) => request.url === '/api/remote.mux'),
      'the upgrade reached the profile with the prefix stripped',
    )
  } finally {
    await entry.close()
    await upstream.close()
  }
})
