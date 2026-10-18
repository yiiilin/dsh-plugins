/**
 * Path-prefix gateway: one origin, many box instances.
 *
 * Every box is reached at `/<id>/` on the fleet origin. Three details make that
 * work against a stock `dsh web` listener, and each one is load-bearing:
 *
 * 1. **The original `Host` is forwarded unchanged.** The listener's Host/Origin
 *    fence compares the request authority with its declared trusted host, so
 *    rewriting `Host` to the loopback upstream yields `HTTP 403` plus an endless
 *    client reconnect loop. The upstream must be started with the fleet
 *    authority in `--trusted-host` instead.
 * 2. **`Set-Cookie` path is scoped to the prefix.** dsh names its browser cookie
 *    `dsh-auth-<sha256(authority)>`, so every box behind one origin computes the
 *    *same* cookie name. With the stock `Path=/` the last login overwrites every
 *    other box and only one box stays signed in. Rewriting the path to `/<id>/`
 *    keeps them as distinct cookies that coexist.
 * 3. **Upgrades are proxied raw.** The client opens a WebSocket for its remote
 *    multiplex; a normal HTTP proxy drops it and the UI sits at "Reconnecting".
 *
 * @module @yiln-dsh/dsh-fleet/gateway
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

/**
 * Scope one `Set-Cookie` value to a path prefix.
 *
 * Only an exact `Path=/` is rewritten; an upstream that already scopes a cookie
 * more narrowly keeps its own narrower scope.
 *
 * @param value - one serialized `Set-Cookie` header value.
 * @param prefix - the box prefix, e.g. `/box1`.
 * @returns the value with its path scoped under the prefix.
 */
export function scopeCookiePath(value, prefix) {
  return value.replace(/;\s*Path=\/(?=;|$)/iu, `; Path=${prefix}/`)
}

/**
 * Split a request URL into the box it addresses and the upstream path.
 *
 * @param url - the raw request URL, with or without a query string.
 * @param ids - the box ids the gateway serves.
 * @returns the matched box id and stripped path, or undefined outside every prefix.
 */
export function routeRequest(url, ids) {
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
 * dsh redirects the launch-token exchange with a relative `./`, which already
 * stays inside the prefix. An absolute origin-relative target such as `/api/…`
 * would leave the box, so it gains the prefix here; an absolute URL with its own
 * scheme and host is a different authority and is left alone.
 *
 * @param location - the upstream `Location` value.
 * @param prefix - the box prefix.
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
 * Start the fleet gateway.
 *
 * @param options - listener settings and the live port lookup.
 * @param options.port - listener port on the fleet host.
 * @param options.host - listener bind address.
 * @param options.resolve - returns the port of a running box, or undefined.
 * @param options.listIds - the box ids to route, in match order.
 * @param options.portal - handles `/` and unknown paths.
 * @returns an object with the listening port and a close function.
 */
export function startGateway({ port, host, resolve, listIds, portal }) {
  const server = createServer((req, res) => {
    const routed = routeRequest(req.url ?? '/', listIds())
    if (routed === undefined) {
      portal(req, res)
      return
    }
    const upstream = resolve(routed.id)
    if (upstream === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`fleet: box "${routed.id}" is not running\n`)
      return
    }
    const prefix = `/${routed.id}`
    const forwarded = httpRequest(
      { host: '127.0.0.1', port: upstream, path: routed.path, method: req.method, headers: req.headers },
      (up) => {
        const headers = { ...up.headers }
        if (headers['set-cookie'] !== undefined) {
          headers['set-cookie'] = [headers['set-cookie']]
            .flat()
            .map((value) => scopeCookiePath(value, prefix))
        }
        if (headers.location !== undefined) headers.location = scopeLocation(headers.location, prefix)
        res.writeHead(up.statusCode ?? 502, headers)
        up.pipe(res)
      },
    )
    forwarded.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`fleet: upstream error: ${error.message}\n`)
    })
    req.pipe(forwarded)
  })

  server.on('upgrade', (req, socket, head) => {
    const routed = routeRequest(req.url ?? '/', listIds())
    const upstream = routed === undefined ? undefined : resolve(routed.id)
    if (routed === undefined || upstream === undefined) {
      socket.destroy()
      return
    }
    const target = connect(upstream, '127.0.0.1', () => {
      const lines = [`GET ${routed.path} HTTP/1.1`]
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`)
      }
      target.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
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
