/**
 * The single entry: one HTTP listener that routes to profile processes.
 *
 * ## Why subpath routing works without any upstream reconfiguration
 *
 * A profile is a stock `dsh web` listener. Three facts make `/<id>/…` work:
 *
 * 1. **The served HTML carries `<base href="./">`**, so every relative asset
 *    URL resolves under the browser's current prefix.
 * 2. **The client resolves its WebSocket against `document.baseURI`**
 *    (`new URL('api/remote.mux', document.baseURI)` in the api-gateway client),
 *    so the mux socket lands on `/<id>/api/remote.mux` and not on the daemon.
 * 3. **`Host` and `Origin` are rewritten to the loopback upstream.** The
 *    profile's `/api` browser-trust fence accepts a loopback authority, so no
 *    `--trusted-host` is needed, and the profile's cookie name is derived from
 *    that authority — unique per port, so profiles never share a cookie.
 *
 * The one thing the upstream cannot know is the prefix, so `Set-Cookie: Path=/`
 * is rewritten to `Path=/<id>/`: without it every profile cookie would be sent
 * to the portal and to every other profile.
 *
 * @module @yiln-dsh/dsh-daemon/entry
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

/**
 * Scope one `Set-Cookie` value to a path prefix.
 *
 * Only an exact `Path=/` is rewritten; a cookie the upstream already scoped more
 * narrowly keeps its own scope.
 *
 * @param value - one serialized `Set-Cookie` header value.
 * @param prefix - the profile prefix, e.g. `/box1`.
 * @returns the value with its path scoped under the prefix.
 */
export function scopeCookiePath(value, prefix) {
  // An exact `Path=/` is the one we own; a narrower one belongs to the upstream and
  // rewriting it would widen a cookie that was deliberately restricted.
  if (/;\s*Path=\/(?=;|$)/iu.test(value)) {
    return value.replace(/;\s*Path=\/(?=;|$)/iu, `; Path=${prefix}/`)
  }
  // Any other Path means the upstream already scoped this cookie. Leave it alone: a
  // second `Path` attribute in one Set-Cookie is a duplicate the browser rejects.
  if (/;\s*Path=/iu.test(value)) return value
  // No Path at all would default to the request's directory, and two environments share
  // one origin — such a cookie would be sent to both.
  return `${value}; Path=${prefix}`
}

/**
 * Split a request path into the profile it addresses and the upstream path.
 *
 * The match is the first path segment, so `/box1` and `/box1/api/x` both belong
 * to `box1` while `/box10` does not.
 *
 * @param url - the raw request URL, with or without a query string.
 * @param ids - the profile ids this entry routes.
 * @returns the matched id and stripped upstream path, or undefined.
 */
export function routeEnvironment(url, ids) {
  const queryAt = url.indexOf('?')
  const path = queryAt === -1 ? url : url.slice(0, queryAt)
  const search = queryAt === -1 ? '' : url.slice(queryAt)
  for (const id of ids) {
    const prefix = `/${id}`
    if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
    const rest = path.slice(prefix.length)
    return { id, path: `${rest === '' ? '/' : rest}${search}` }
  }
  return undefined
}

/**
 * Rewrite an upstream `Location` header so a redirect cannot escape its prefix.
 *
 * `dsh` answers the launch-token exchange with a relative `./`, which already
 * stays inside the prefix; an origin-absolute target such as `/api/…` would
 * leave it, so it gains the prefix here.
 *
 * @param location - the upstream `Location` value.
 * @param prefix - the profile prefix.
 * @returns the value safe to send to the browser.
 */
export function scopeLocation(location, prefix) {
  if (location === undefined || location.length === 0) return location
  if (/^[a-z][a-z0-9+.-]*:/iu.test(location)) return location
  if (location.startsWith('/') && !location.startsWith('//')) {
    if (location === prefix || location.startsWith(`${prefix}/`)) return location
    return `${prefix}${location}`
  }
  return location
}

/**
 * Start the entry listener.
 *
 * @param options - listener settings and the live routing hooks.
 * @param options.host - bind address (`0.0.0.0` is allowed here; this listener
 *   is the authenticated surface, unlike a profile's loopback port).
 * @param options.port - bind port.
 * @param options.listEnvironments - returns `{ id, online }` for every environment.
 * @param options.local - handles a daemon-owned request; returns true when it
 *   wrote the response. Everything it declines is matched against profiles.
 * @param options.root - the upstream that owns paths no prefix claims, or
 *   undefined to answer 404. It supplies the port, a cached `cookie()` for the
 *   upstream session, `ensure()` to mint it, and `refresh()` to drop it after a
 *   rejection. When `prefix` is set, the root is reached under that prefix and
 *   every other path redirects there.
 * @param options.tunnel - `{ path, server, tokenOf, hub }`: where edges connect, the
 *   WebSocket server that accepts them, how a token is read, and the hub that proxies
 *   requests into them.
 * @param options.notFound - writes a response for an unroutable request.
 * @returns the listening port and a close function.
 */
export function startEntry({ host, port, listEnvironments, local, root, tunnel, notFound }) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    void handleHttp({ req, res, url, listEnvironments, local, root, tunnel, notFound }).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`daemon: request failed: ${error?.message ?? error}\n`)
        return
      }
      res.destroy()
    })
  })

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]

    // An edge presenting itself. Checked before any environment prefix so an
    // environment can never be named into this path.
    if (tunnel !== undefined && path === tunnel.path) {
      const token = tunnel.tokenOf(req)
      const environment = token === '' ? undefined : tunnel.hub.verify(token)
      if (environment === undefined) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
        return
      }
      tunnel.server.handleUpgrade(req, socket, head, (ws) => {
        tunnel.hub.accept(environment, ws)
      })
      return
    }

    const routed = routeEnvironment(url, listEnvironments().map((entry) => entry.id))
    if (routed !== undefined && tunnel !== undefined) {
      if (!tunnel.hub.proxyUpgrade(routed.id, req, socket, head, routed.path)) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
      }
      return
    }
    // The root profile's client opens its mux socket against `document.baseURI`,
    // which is the daemon's own origin; the handshake has to carry the session
    // the daemon holds for it.
    if (root !== undefined) {
      const mount = root.prefix === undefined || root.prefix === '' ? '' : `/${root.prefix.replace(/^\/+|\/+$/gu, '')}`
      const path = url.split('?')[0]
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : ''
      const inside = mount === '' || path === mount || path.startsWith(`${mount}/`)
      if (!inside) {
        socket.destroy()
        return
      }
      const upstreamPath = mount === '' ? url : `${path.slice(mount.length) || '/'}${search}`
      void root.ensure().then(() => {
        proxyUpgrade({ req, socket, head, port: root.port(), path: upstreamPath, cookie: root.cookie() })
      }).catch(() => socket.destroy())
      return
    }
    socket.destroy()
  })

  return new Promise((resolveStarted, rejectStarted) => {
    server.once('error', rejectStarted)
    server.listen(port, host, () => {
      server.off('error', rejectStarted)
      const address = server.address()
      resolveStarted({
        port: typeof address === 'object' && address !== null ? address.port : port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

async function handleHttp({ req, res, url, listEnvironments, local, root, tunnel, notFound }) {
  // Daemon-owned paths win: the portal, the login endpoints and `/admin` must
  // never be reachable through a profile whose id happens to look similar.
  let handled
  try {
    handled = await local(req, res, url)
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    } else {
      res.destroy()
    }
    return
  }
  if (handled) return

  if (root?.prefix !== undefined && root.prefix !== '') {
    const prefix = `/${root.prefix.replace(/^\/+|\/+$/gu, '')}`
    const path = url.split('?')[0]
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      await root.ensure()
      const rest = path.slice(prefix.length)
      const search = url.includes('?') ? url.slice(url.indexOf('?')) : ''
      proxyRequest({
        req,
        res,
        port: root.port(),
        path: `${rest === '' ? '/' : rest}${search}`,
        prefix,
        cookie: root.cookie(),
        refresh: root.refresh,
      })
      return
    }
  }

  const routed = routeEnvironment(url, listEnvironments().map((entry) => entry.id))
  if (routed !== undefined) {
    if (tunnel !== undefined && tunnel.hub.proxy(routed.id, req, res, routed.path)) return
    // Offline is a state, not a deletion: say which environment is unreachable
    // instead of a bare 404, which reads as 'this environment does not exist'.
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(offlinePage(routed.id))
    return
  }
  // No prefix claimed this path, so it belongs to the root profile. That profile
  // is a stock `dsh web` listener gated on a cookie derived from *its own*
  // authority, which a browser talking to the daemon can never present — the
  // daemon holds that session itself and attaches it here.
  if (root !== undefined) {
    const mount = root.prefix
    if (mount !== undefined && mount !== '') {
      // The harness is mounted under `mount`; bare `/` sends the browser there so
      // its relative asset URLs resolve against the mount rather than the root.
      const absolute = mount.startsWith('/') ? mount : `/${mount}`
      res.writeHead(302, { location: `${absolute}/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    await root.ensure()
    proxyRequest({ req, res, port: root.port(), path: url, prefix: '', cookie: root.cookie(), refresh: root.refresh })
    return
  }
  notFound(req, res, url)
}

/** A page for an environment that has no tunnel right now. */
function offlinePage(id) {
  const safe = String(id).replace(/[<>&"]/gu, (ch) => `&#${ch.codePointAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>${safe} offline</title>`
    + '<style>body{font:14px system-ui;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#444}'
    + 'code{background:#f4f4f4;padding:.15em .35em;border-radius:3px}</style>'
    + `<h1 style="font-size:1.15rem">环境 <code>${safe}</code> 当前离线</h1>`
    + '<p>这台机器上的 dsh 没有连到主节点。它可能关机、断网，或它的 daemon 没有运行。</p>'
    + '<p>环境仍然存在，隧道恢复后这里会自动可用。</p>'
}

/**
 * Forward one HTTP request to a profile's loopback listener.
 *
 * `Host` and `Origin` are rewritten together: the profile's fence compares them,
 * and rewriting only one would answer 403.
 */
function proxyRequest({ req, res, port, path, prefix, cookie, refresh }) {
  const authority = `127.0.0.1:${port}`
  const headers = { ...req.headers }
  if (cookie !== undefined) {
    // Replace, never append: the browser's cookie names a different authority,
    // so forwarding it would make the upstream look up an unknown session.
    headers.cookie = cookie
  }
  headers.host = authority
  if (headers.origin !== undefined) headers.origin = `http://${authority}`
  headers['x-forwarded-for'] = clientAddress(req)
  for (const hop of ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    delete headers[hop]
  }

  const upstream = httpRequest({ host: '127.0.0.1', port, path, method: req.method, headers }, (answer) => {
    const outHeaders = { ...answer.headers }
    if (outHeaders['set-cookie'] !== undefined) {
      outHeaders['set-cookie'] = [outHeaders['set-cookie']]
        .flat()
        .map((value) => scopeCookiePath(value, prefix))
    }
    if (outHeaders.location !== undefined) outHeaders.location = scopeLocation(outHeaders.location, prefix)
    // The upstream session outlives a core restart only until its first use. A
    // single retry against a fresh exchange turns that into a transparent reload
    // instead of a 401 the browser cannot explain.
    if (answer.statusCode === 401 && refresh !== undefined) {
      answer.resume()
      refresh()
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '1' })
      res.end('daemon: upstream session refreshed, retry\n')
      return
    }
    res.writeHead(answer.statusCode ?? 502, outHeaders)
    answer.pipe(res)
  })

  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`daemon: upstream error: ${error.message}\n`)
  })
  req.pipe(upstream)
}

/**
 * Tunnel one WebSocket handshake to a profile.
 *
 * The handshake is replayed byte-for-byte so the profile sees the same headers
 * it would have seen directly, except for the loopback `Host`/`Origin` pair.
 */
function proxyUpgrade({ req, socket, head, port, path, cookie }) {
  const authority = `127.0.0.1:${port}`
  const target = connect(port, '127.0.0.1', () => {
    const lines = [`GET ${path} HTTP/1.1`]
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index]
      const value = req.rawHeaders[index + 1]
      const lower = name.toLowerCase()
      if (lower === 'host') {
        lines.push(`${name}: ${authority}`)
        continue
      }
      if (lower === 'origin') {
        lines.push(`${name}: http://${authority}`)
        continue
      }
      if (lower === 'cookie' && cookie !== undefined) {
        lines.push(`${name}: ${cookie}`)
        continue
      }
      lines.push(`${name}: ${value}`)
    }
    target.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) target.write(head)
    socket.pipe(target)
    target.pipe(socket)
  })
  target.on('error', () => socket.destroy())
  socket.on('error', () => target.destroy())
}

function clientAddress(req) {
  const address = req.socket.remoteAddress
  return address ?? '127.0.0.1'
}
