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
 * @module @yiln-dsh/dsh-gateway/entry
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
 * @param options.localProfile - resolves a `local` environment to a loopback upstream:
 *   `{ port, cookie, ensure, refresh }` per environment id, or undefined when the id is
 *   not a local one. Absent means this node runs no local profiles.
 * @param options.notFound - writes a response for an unroutable request.
 * @returns the listening port and a close function.
 */
export function startEntry({ host, port, listEnvironments, local, root, tunnel, localProfile, notFound }) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    void handleHttp({ req, res, url, listEnvironments, local, root, tunnel, localProfile, notFound }).catch((error) => {
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
      // The connecting node names itself; the upstream does not invent a name for it.
      const claim = new URL(`http://x${url}`).searchParams
      tunnel.server.handleUpgrade(req, socket, head, (ws) => {
        tunnel.hub.accept(environment, ws, {
          name: claim.get('name') ?? '',
          hostname: claim.get('hostname') ?? '',
          harnessPort: Number(claim.get('harnessPort')) || 0,
          // The id this node calls itself. Unique and self-generated, so it is the node's
          // to declare — the registry's stored id is only what the operator typed.
          envId: claim.get('envId') ?? '',
        })
      })
      return
    }

    const routed = routeEnvironment(url, listEnvironments().map((entry) => entry.id))
    // A local profile answers on loopback, so its mux socket is proxied the same way its
    // HTTP is — no tunnel involved. Resolved before the tunnel branch so one id can
    // never be both.
    if (routed !== undefined && localProfile !== undefined) {
      const upstream = localProfile(routed.id)
      if (upstream !== undefined) {
        void upstream.ensure().then(() => {
          proxyUpgrade({
            req,
            socket,
            head,
            port: upstream.port(),
            path: routed.path,
            cookie: upstream.cookie(),
          })
        }).catch((error) => {
          socket.end(`HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n`)
          void error
        })
        return
      }
    }
    if (routed !== undefined && tunnel !== undefined) {
      proxyUpgradeOverTunnel(tunnel.hub, routed.id, req, socket, head, routed.path)
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

async function handleHttp({ req, res, url, listEnvironments, local, root, tunnel, localProfile, notFound }) {
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

  const knownIds = listEnvironments().map((entry) => entry.id)
  const routed = routeEnvironment(url, knownIds)
  if (process.env.DBG) console.error(`[entry] url=${url} known=${JSON.stringify(knownIds.map((k) => k.slice(0, 10)))} routed=${JSON.stringify(routed)} tunnel=${tunnel !== undefined}`)
  if (routed !== undefined && localProfile !== undefined) {
    const upstream = localProfile(routed.id)
    if (upstream !== undefined) {
      try {
        await upstream.ensure()
      } catch (error) {
        // A profile that cannot start is a state to report, not a blank 404.
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(offlinePage(routed.id, String(error?.message ?? error)))
        return
      }
      proxyRequest({
        req,
        res,
        port: upstream.port(),
        path: routed.path,
        prefix: `/${routed.id}`,
        cookie: upstream.cookie(),
        refresh: upstream.refresh,
      })
      return
    }
  }
  /**
   * Carry one browser request to a remote environment through the tunnel.
   *
   * The tunnel moves bytes, so the browser's request is re-serialized onto a stream and the
   * environment's answer is written back as it arrives. This is the same mechanism the
   * peer accessor uses; it lives here because this is the browser-facing path, which must
   * preserve streaming — a page, an upload or an event stream all take it.
   *
   * @param hub - the tunnel hub.
   * @param envId - destination environment.
   * @param req - the browser's request.
   * @param res - the browser's response.
   * @param upstreamPath - path as the environment should see it.
   * @returns whether the request could be sent.
   */
  /**
   * Split an upstream HTTP response into its head and body, and pass both to `res`.
   *
   * The tunnel returns bytes, so a proxied answer arrives exactly as the remote daemon
   * wrote it: status line, headers, then body. `res` is already the browser's response
   * object, so the head cannot simply be forwarded — it has to be read, turned into
   * `writeHead`, and only then may body bytes follow.
   *
   * @param res - the browser's response.
   * @returns `{ push(bytes) }`.
   */
  function createResponseSplitter(res, envId) {
    let buffer = Buffer.alloc(0)
    let headSent = false
    // The remote daemon answers over HTTP/1.1, which defaults to chunked framing even when
    // the request says `Connection: close`. The framing has to be removed here, because
    // `res` adds its own: leaving it produced a body starting with a hex size and a CRLF.
    let chunked = false
    let pending = Buffer.alloc(0)
    return {
      push(piece) {
        if (res.writableEnded) return
        if (headSent) {
          writeBody(piece)
          return
        }
        buffer = Buffer.concat([buffer, piece])
        const boundary = buffer.indexOf('\r\n\r\n')
        if (boundary === -1) return
        const head = buffer.subarray(0, boundary).toString('latin1')
        const rest = buffer.subarray(boundary + 4)
        const [statusLine, ...headerLines] = head.split('\r\n')
        const match = /^HTTP\/\d+\.\d+ (\d{3})(?: (.*))?$/u.exec(statusLine ?? '')
        const status = match === null ? 502 : Number(match[1])
        const headers = {}
        const cookies = []
        for (const line of headerLines) {
          const at = line.indexOf(':')
          if (at <= 0) continue
          const name = line.slice(0, at).trim().toLowerCase()
          const value = line.slice(at + 1).trim()
          // Length and framing are the browser's business now, and a stale
          // `content-length` would truncate a streamed body.
          // `content-length` is kept: it describes the body the far side actually sent,
          // and dropping it left the browser reading an empty answer. Only the framing the
          // near side owns is dropped — `transfer-encoding` and `connection`.
          if (name === 'transfer-encoding' || name === 'connection') continue
          // A cookie the far harness scoped to `/` would be sent to the portal and to every
          // other environment; scoped to this environment's prefix, it only comes back
          // here. `res.writeHead` takes one value per name, so several cookies have to be
          // joined rather than overwritten.
          if (name === 'set-cookie') {
            // Several cookies share this header name, so they are collected as an array
            // and set with `setHeader`, which is the one form Node serializes correctly.
            cookies.push(scopeCookiePath(value, `/${envId}`))
            continue
          }
          headers[name] = value
        }
        chunked = /\bchunked\b/iu.test(head)
        // Headers must be set *before* `writeHead`: afterwards Node throws
        // ERR_HTTP_HEADERS_SENT, which is an uncaught exception and took the whole daemon
        // down. `set-cookie` is the one header Node needs written first, because several
        // cookies share the name and only an array serializes correctly.
        if (cookies.length > 0) res.setHeader('set-cookie', cookies)
        res.writeHead(status, headers)
        headSent = true
        if (rest.length > 0) writeBody(rest)
      },
    }

    /** Write body bytes, un-framing them first when the upstream chunked the answer. */
    function writeBody(piece) {
      if (!chunked) {
        res.write(piece)
        return
      }
      pending = Buffer.concat([pending, piece])
      for (;;) {
        const lineEnd = pending.indexOf('\r\n')
        if (lineEnd === -1) return
        const size = Number.parseInt(pending.subarray(0, lineEnd).toString('latin1').trim(), 16)
        if (!Number.isFinite(size)) {
          // Not a chunk header after all; forward the rest untouched rather than lose it.
          res.write(pending)
          pending = Buffer.alloc(0)
          chunked = false
          return
        }
        if (size === 0) {
          pending = Buffer.alloc(0)
          return
        }
        if (pending.length < lineEnd + 2 + size + 2) return
        res.write(pending.subarray(lineEnd + 2, lineEnd + 2 + size))
        pending = pending.subarray(lineEnd + 2 + size + 2)
      }
    }
  }

  function proxyToEnvironment(hub, envId, req, res, upstreamPath) {
    if (process.env.DBG) console.error(`[proxy] env=${String(envId).slice(0,8)} reach=${hub.isReachable(envId)} path=${upstreamPath}`)
    if (hub.isReachable(envId) !== true) return false
    // The far side answers with a complete HTTP response, status line and headers
    // included — the tunnel carries bytes, not a parsed response. Writing those bytes
    // straight to `res` makes the browser read them as the *body* of a response whose
    // head it already has, so the head has to be parsed off the front here.
    const relay = createResponseSplitter(res, envId)
    // `/admin` belongs to the daemon and everything else is the profile's own UI, which
    // lives behind its harness listener. Sending page requests to the daemon returned its
    // login page — the reason a proxied environment never showed its own interface.
    const administered = upstreamPath === '/admin' || upstreamPath.startsWith('/admin/')
    const opened = hub.openStream(envId, {
      target: administered ? undefined : 'harness',
      sink(piece) {
        relay.push(piece)
      },
      onEnd() {
        if (!res.writableEnded) res.end()
      },
      onError() {
        if (!res.writableEnded) res.destroy()
      },
      port: 0,
    })
    if (opened.ok !== true) return false

    // Re-serialize the request: method, path, headers, then body pieces as they arrive.
    const lines = [`${req.method ?? 'GET'} ${upstreamPath} HTTP/1.1`]
    // The far harness signs its session cookie against the authority it was asked on. Left
    // as the browser's own host — `dsh.yiln.de` behind a reverse proxy — the cookie is
    // issued for an address the browser never presents again, so it is discarded and every
    // visit lands on "authentication required". The peer's loopback authority is what its
    // `/api` trust fence expects, and it is the contract the upgrade path already follows.
    const forwardedAuthority = administered ? '' : (hub.harnessAuthorityOf?.(envId) ?? '')
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      // `transfer-encoding` is dropped so the answer comes back unframed: the tunnel is
      // the framing, and a chunked body would arrive with its size markers intact.
      if (lower === 'transfer-encoding') continue
      if (lower === 'host' && forwardedAuthority !== '') {
        lines.push(`${name}: ${forwardedAuthority}`)
        continue
      }
      if (lower === 'origin' && forwardedAuthority !== '') {
        lines.push(`${name}: http://${forwardedAuthority}`)
        continue
      }
      lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
    }
    // A request with no body still needs to say so. Without a length the far daemon waits
    // for one that will never come, and the caller sees a 200 with an empty body — the
    // exact symptom that made every proxied `/admin` read empty.
    if (req.headers['content-length'] === undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      lines.push('content-length: 0')
    }
    lines.push('Connection: close')
    const wire = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8')
    opened.send(wire)
    req.on('data', (piece) => opened.send(piece))
    req.on('end', () => opened.end())
    // A browser that goes away must not leave the far side working for nobody.
    res.on('close', () => {
      if (!res.writableEnded) opened.end()
    })
    return true
  }

  if (routed !== undefined) {
    if (tunnel !== undefined && proxyToEnvironment(tunnel.hub, routed.id, req, res, routed.path)) return
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
function offlinePage(id, failure) {
  const safe = String(id).replace(/[<>&"]/gu, (ch) => `&#${ch.codePointAt(0)};`)
  const style = '<style>body{font:14px system-ui;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#444}'
    + 'code{background:#f4f4f4;padding:.15em .35em;border-radius:3px}</style>'
  // A local profile that failed to start is a different situation from an edge whose
  // tunnel is down, and the operator's next move is different too, so the page says
  // which one this is instead of reusing the tunnel wording.
  if (failure !== undefined) {
    const reason = String(failure).replace(/[<>&"]/gu, (ch) => `&#${ch.codePointAt(0)};`)
    return `<!doctype html><meta charset="utf-8"><title>${safe} 启动失败</title>`
      + style
      + `<h1 style="font-size:1.15rem">本机 profile <code>${safe}</code> 启动失败</h1>`
      + `<p>${reason}</p>`
      + '<p>环境仍然存在；修好它之后刷新本页即可。</p>'
  }
  return `<!doctype html><meta charset="utf-8"><title>${safe} offline</title>`
    + style
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
/**
 * Carry an upgraded connection to a remote environment through the tunnel.
 *
 * An upgrade is a two-way byte stream once the handshake is done, which is exactly what
 * the tunnel moves — so the local half is a TCP socket and the remote half is a stream,
 * and the two are piped together. The handshake itself is replayed to the far side with
 * the authority rewritten, because the remote daemon fences on `Host` and `Origin` and
 * would reject the browser's.
 *
 * The cookie is *not* rewritten: only the remote process can mint a session its own
 * harness accepts. It forwards the browser's cookie unchanged, and the remote daemon
 * decides — which is the same trust model the HTTP proxy follows.
 *
 * @param hub - the tunnel hub.
 * @param envId - destination environment.
 * @param req - the upgrade request.
 * @param socket - the browser's socket.
 * @param head - bytes already read past the request head.
 * @param path - path as the environment should see it.
 */
function proxyUpgradeOverTunnel(hub, envId, req, socket, head, path) {
  if (hub.isReachable(envId) !== true) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
    return
  }

  const authority = hub.harnessAuthorityOf?.(envId) ?? ''
  const lines = [`GET ${path} HTTP/1.1`]
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]
    const value = req.rawHeaders[index + 1]
    const lower = name.toLowerCase()
    // Hop-by-hop headers describe *this* connection; the far side makes its own.
    if (lower === 'connection' || lower === 'upgrade' || lower === 'keep-alive') continue
    // `Host` and `Origin` are rewritten to the far side's own loopback authority, which is
    // what its `/api` browser-trust fence accepts. Forwarding the browser's authority makes
    // that fence reject the upgrade, and the fence cannot be relaxed here — it exists so a
    // *page* cannot open the socket. The port comes from the peer's own report, because a
    // port number cannot be derived.
    if (lower === 'host' && authority !== '') {
      lines.push(`${name}: ${authority}`)
      continue
    }
    if (lower === 'origin' && authority !== '') {
      lines.push(`${name}: http://${authority}`)
      continue
    }
    lines.push(`${name}: ${value}`)
  }
  // Both are required for the far daemon to accept the upgrade, and both describe the
  // connection the tunnel provides.
  lines.push('Connection: Upgrade')
  lines.push(`Upgrade: ${req.headers.upgrade ?? 'websocket'}`)

  const opened = hub.openStream(envId, {
    // The profile's own web UI lives behind the far node's harness listener, which this
    // side cannot name — so it asks for "harness" and the far node resolves it.
    target: 'harness',
    sink(piece) {
      if (!socket.destroyed) socket.write(piece)
    },
    onEnd() {
      socket.end()
    },
    onError() {
      socket.destroy()
    },
  })
  if (opened.ok !== true) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
    return
  }

  opened.send(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'))
  if (head.length > 0) opened.send(head)
  socket.on('data', (piece) => opened.send(piece))
  socket.on('end', () => opened.end())
  socket.on('close', () => opened.end())
  socket.on('error', () => opened.end())
}

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
