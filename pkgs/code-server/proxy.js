/**
 * Reverse proxy for one code-server instance.
 *
 * code-server is mounted at `/`, but the Harness serves it under
 * `/_dsh/code-server/i/<id>/`. Three facts make that work without patching
 * code-server (see its `docs/FAQ.md`, `src/node/http.ts` and the
 * `patches/base-path.diff` patch):
 *
 * - Its workbench HTML uses **relative** URLs computed from
 *   `relativeRoot(req.originalUrl)`, so forwarding the path with our prefix
 *   stripped makes `{{BASE}}`, `{{CS_STATIC_BASE}}` and relative redirects
 *   resolve against the browser's own prefixed URL.
 * - `patches/base-path.diff` rewrites VS Code's WebSocket URL to
 *   `window.location.pathname + "/" + path`, so the socket stays under the
 *   iframe's prefix and an exact upgrade route can own it.
 * - Its websocket router matches every path, so any upstream path is accepted.
 *
 * `Host` and `Origin` are rewritten to the loopback authority together:
 * code-server's origin fence compares them, and rewriting only one of them
 * answers 403. Cookies with `Path=/` are scoped to the prefix so a
 * code-server cookie cannot reach the Harness or another instance.
 *
 * @module @yiln-dsh/dsh-code-server/proxy
 */

import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'

/** Headers that must not be copied onto an ordinary proxied HTTP response. */
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization',
]

/**
 * Strip the mount prefix from a request URL, preserving its query string.
 *
 * The caller already matched the prefix route, so the pathname is known to
 * start with `prefix`. A request for the prefix itself becomes `/`, which is
 * exactly the workbench root code-server expects.
 *
 * @param {string} reqUrl raw request URL, with or without a query.
 * @param {string} prefix absolute pathname of this instance, no trailing slash.
 * @returns {string} the upstream path.
 */
export function upstreamPath(reqUrl, prefix) {
  const url = new URL(typeof reqUrl === 'string' && reqUrl !== '' ? reqUrl : '/', 'http://dsh.local')
  let rest = url.pathname.slice(prefix.length)
  if (rest === '') rest = '/'
  else if (!rest.startsWith('/')) rest = `/${rest}`
  return `${rest}${url.search}`
}

/**
 * Scope one `Set-Cookie` value to the instance prefix.
 *
 * Only an exact `Path=/` is rewritten; a narrower path belongs to the upstream
 * and widening it would be wrong. A cookie with no `Path` at all would default
 * to the request's directory, which is shared by every instance.
 *
 * @param {string} value one serialized Set-Cookie header value.
 * @param {string} prefix absolute pathname of this instance.
 * @returns {string} the scoped value.
 */
export function scopeSetCookie(value, prefix) {
  if (/;\s*Path=\/(?=;|$)/iu.test(value)) {
    return value.replace(/;\s*Path=\/(?=;|$)/iu, `; Path=${prefix}/`)
  }
  if (/;\s*Path=/iu.test(value)) return value
  return `${value}; Path=${prefix}`
}

/**
 * Keep an upstream redirect inside the prefix.
 *
 * code-server deliberately emits relative redirects (`./…`), which already
 * resolve against the browser's prefixed URL and must be left alone. An
 * origin-absolute `/…` would escape, so it gains the prefix. Absolute URLs
 * and protocol-relative `//…` are left to the upstream.
 *
 * @param {string} location the upstream Location value.
 * @param {string} prefix absolute pathname of this instance.
 * @returns {string} the safe value.
 */
export function scopeLocation(location, prefix) {
  if (typeof location !== 'string' || location === '') return location
  if (/^[a-z][a-z0-9+.-]*:/iu.test(location)) return location
  if (location.startsWith('//')) return location
  if (!location.startsWith('/')) return location
  if (location === prefix || location.startsWith(`${prefix}/`)) return location
  return `${prefix}${location}`
}

/**
 * Refuse a cross-site request that presents a foreign Origin.
 *
 * The Harness already gates its own routes on an authenticated cookie; this is
 * the extra fence on the routes that spawn or tear down processes, and on the
 * upgrade that hands a raw socket to a child. A missing Origin is a non-browser
 * client and is allowed, exactly as code-server's own fence allows it.
 *
 * @param {string|undefined} origin the request's Origin header.
 * @param {string|undefined} host the request's Host header.
 * @returns {boolean} whether the request is same-origin (or origin-less).
 */
export function isSameOriginRequest(origin, host) {
  if (origin === undefined || origin === null || origin === '') return true
  if (typeof origin !== 'string' || typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** Headers sent to the loopback upstream for one ordinary HTTP request. */
function requestHeaders(req, authority) {
  const headers = { ...req.headers }
  headers.host = authority
  if (headers.origin !== undefined) headers.origin = `http://${authority}`
  // The Harness auth cookie is scoped to Path=/ and would otherwise be sent
  // to code-server on every request. With --auth none the child needs no
  // cookie of ours, so none is forwarded — neither the session token nor
  // anything else the browser happens to hold for this origin.
  delete headers.cookie
  headers['x-forwarded-for'] = req.socket?.remoteAddress ?? '127.0.0.1'
  headers['x-forwarded-proto'] = 'http'
  headers['x-forwarded-host'] = String(req.headers?.host ?? authority)
  for (const hop of HOP_BY_HOP) delete headers[hop]
  return headers
}

/**
 * Forward one HTTP request to a code-server instance's loopback listener.
 *
 * @param {object} options
 * @param {import('node:http').IncomingMessage} options.req the browser request.
 * @param {import('node:http').ServerResponse} options.res the browser response.
 * @param {number} options.port the instance's loopback port.
 * @param {string} options.path prefix-stripped upstream path.
 * @param {string} options.prefix absolute pathname of this instance.
 * @returns {void}
 */
export function proxyHttp({ req, res, port, path, prefix }) {
  const authority = `127.0.0.1:${port}`
  const upstream = httpRequest({
    host: '127.0.0.1',
    port,
    path,
    method: req.method,
    headers: requestHeaders(req, authority),
  }, (answer) => {
    const out = { ...answer.headers }
    for (const hop of HOP_BY_HOP) delete out[hop]
    // code-server's service worker would otherwise be allowed to claim the
    // whole Harness origin. Keep it inside its own directory.
    delete out['service-worker-allowed']
    if (out['set-cookie'] !== undefined) {
      out['set-cookie'] = [out['set-cookie']].flat().map((value) => scopeSetCookie(value, prefix))
    }
    if (typeof out.location === 'string') out.location = scopeLocation(out.location, prefix)
    res.writeHead(answer.statusCode ?? 502, out)
    answer.pipe(res)
  })
  upstream.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`code-server: upstream error: ${message}\n`)
  })
  res.once('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

/**
 * Replay one WebSocket handshake to a code-server instance.
 *
 * The handshake is replayed byte-for-byte so code-server sees the same
 * `Connection`/`Upgrade`/`Sec-WebSocket-*` headers it would have seen
 * directly; only `Host` and `Origin` become the loopback authority. Hop-by-hop
 * headers are deliberately **kept** here — removing `Connection: Upgrade`
 * would turn the request into an ordinary GET.
 *
 * @param {object} options
 * @param {import('node:http').IncomingMessage} options.req the upgrade request.
 * @param {import('node:stream').Duplex} options.socket the raw browser socket.
 * @param {Buffer} options.head bytes already read past the request line.
 * @param {number} options.port the instance's loopback port.
 * @param {string} options.path prefix-stripped upstream path.
 * @returns {void}
 */
export function proxyUpgrade({ req, socket, head, port, path }) {
  const authority = `127.0.0.1:${port}`
  const target = connect(port, '127.0.0.1', () => {
    const lines = [`GET ${path} HTTP/1.1`]
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index]
      const lower = name.toLowerCase()
      // The Harness session cookie must not reach the child (see requestHeaders).
      if (lower === 'cookie') continue
      let value = req.rawHeaders[index + 1]
      if (lower === 'host') value = authority
      else if (lower === 'origin') value = `http://${authority}`
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
