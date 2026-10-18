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
  return value.replace(/;\s*Path=\/(?=;|$)/iu, `; Path=${prefix}/`)
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
export function routeProfile(url, ids) {
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
 * @param options.listProfiles - returns `{ id, port }` for every running profile.
 * @param options.local - handles a daemon-owned request; returns true when it
 *   wrote the response. Everything it declines is matched against profiles.
 * @param options.notFound - writes a response for an unroutable request.
 * @returns the listening port and a close function.
 */
export function startEntry({ host, port, listProfiles, local, notFound }) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    void handleHttp({ req, res, url, listProfiles, local, notFound })
  })

  server.on('upgrade', (req, socket, head) => {
    const routed = routeProfile(req.url ?? '/', listProfiles().map((entry) => entry.id))
    const upstream = routed === undefined ? undefined : findPort(listProfiles(), routed.id)
    if (routed === undefined || upstream === undefined) {
      socket.destroy()
      return
    }
    proxyUpgrade({ req, socket, head, port: upstream, path: routed.path })
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

async function handleHttp({ req, res, url, listProfiles, local, notFound }) {
  // Daemon-owned paths win: the portal, the login endpoints and `/admin` must
  // never be reachable through a profile whose id happens to look similar.
  if (await local(req, res, url)) return

  const routed = routeProfile(url, listProfiles().map((entry) => entry.id))
  const upstream = routed === undefined ? undefined : findPort(listProfiles(), routed.id)
  if (routed === undefined || upstream === undefined) {
    notFound(req, res, url)
    return
  }
  proxyRequest({ req, res, port: upstream, path: routed.path, prefix: `/${routed.id}` })
}

function findPort(profiles, id) {
  const entry = profiles.find((candidate) => candidate.id === id)
  return entry === undefined ? undefined : entry.port
}

/**
 * Forward one HTTP request to a profile's loopback listener.
 *
 * `Host` and `Origin` are rewritten together: the profile's fence compares them,
 * and rewriting only one would answer 403.
 */
function proxyRequest({ req, res, port, path, prefix }) {
  const authority = `127.0.0.1:${port}`
  const headers = { ...req.headers }
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
function proxyUpgrade({ req, socket, head, port, path }) {
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
