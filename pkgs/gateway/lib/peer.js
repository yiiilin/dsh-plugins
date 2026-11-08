/**
 * One way to reach any environment, including this one.
 *
 * Every capability used to carry the same three-way branch:
 *
 * ```js
 * if (envId === '' || envId === 'self') return answerLocally()
 * if (config.role !== 'main')           return agent.readRemote(envId, ...)
 *                                       return hub.relayOverTunnel(envId, ...)
 * ```
 *
 * Five capabilities wrote it out five times, and the shape invited one specific mistake:
 * asking a question about the topology that only some roles can answer. That happened —
 * an edge checked its own tunnel table for a peer, which is always empty there, so every
 * edge-to-edge message reported "offline".
 *
 * Here the branch exists once. A caller names the environment and the request; whether
 * that is a loopback call to this daemon or an HTTP request against a relay port is this
 * module's business. In both cases the caller speaks plain HTTP, because both paths end
 * at a daemon that does.
 *
 * @module @yiln-dsh/dsh-gateway/peer
 */

import { request as httpRequest } from 'node:http'

/**
 * Build the peer accessor for this node.
 *
 * @param options.selfId - the id meaning "this node".
 * @param options.localPort - this node's own HTTP port.
 * @param options.relay - the stream relay; `portFor(envId)` answers a loopback port.
 * @param options.knownIds - the environments that can be reached, for a clearer refusal.
 * @param options.logger - logger.
 * @returns `{ json, stream, isLocal }`.
 */
export function createPeerAccess({ selfId = 'self', localPort, relay, knownIds = () => [], logger }) {
  /** Whether this request is for the node asking. */
  function isLocal(envId) {
    // Resolved per call: a node learns its own id after this accessor is built.
    const mine = typeof selfId === 'function' ? selfId() : selfId
    // `'self'` is the alias the environment list hands out, so a caller that echoes it back
    // must land here. Comparing only against the real id sent it down the remote path,
    // where no route to `'self'` exists — the answer was a hung socket, not a clear refusal.
    return envId === undefined || envId === '' || envId === 'self' || envId === mine
  }

  /**
   * The loopback port that reaches `envId`.
   *
   * Local targets go straight to this daemon; everything else goes through the relay,
   * which owns a listener per destination.
   */
  async function targetPort(envId) {
    if (isLocal(envId)) return localPort()
    if (!knownIds().includes(envId)) {
      return undefined
    }
    return await relay.portFor(envId)
  }

  /**
   * Send one request and collect the whole answer.
   *
   * @param envId - destination; empty or self means this node.
   * @param request - `{ method, path, headers, body, timeoutMs }`.
   * @returns `{ ok, status, headers, body }` or `{ ok: false, error }`.
   */
  function send(envId, { method = 'GET', path, headers = {}, body, timeoutMs = 300_000 }) {
    return new Promise((resolve) => {
      void (async () => {
        const port = await targetPort(envId)
        if (port === undefined) {
          resolve({ ok: false, error: `environment "${envId}" is not reachable from this node` })
          return
        }
        const payload = body === undefined
          ? undefined
          : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)))
        const allHeaders = { ...headers }
        // A request arriving over the tunnel is not a browser: only a node holding this
        // connection's token can put bytes on it. Saying so is what lets the far daemon
        // skip its session gate — without the header it answered with the login page.
        if (isLocal(envId) === false) allHeaders['x-dsh-federation'] = 'tunnel'
        if (payload !== undefined) {
          allHeaders['content-length'] = String(payload.length)
          allHeaders['content-type'] ??= 'application/json'
        }

        const request = httpRequest({
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: allHeaders,
        }, (answer) => {
          const pieces = []
          answer.on('data', (piece) => pieces.push(piece))
          answer.on('end', () => resolve({
            ok: answer.statusCode >= 200 && answer.statusCode < 300,
            status: answer.statusCode,
            headers: answer.headers,
            body: Buffer.concat(pieces),
          }))
          answer.on('error', (error) => resolve({ ok: false, error: error.message }))
        })
        request.setTimeout(timeoutMs, () => {
          request.destroy()
          resolve({ ok: false, error: `environment "${envId}" did not answer in time` })
        })
        request.on('error', (error) => resolve({ ok: false, error: error.message }))
        if (payload !== undefined) request.write(payload)
        request.end()
      })()
    })
  }

  return {
    isLocal,

    /**
     * Ask one environment for a JSON answer.
     *
     * @returns `{ ok, status?, body?, error? }`; `body` is the parsed JSON.
     */
    async json(envId, request) {
      const answer = await send(envId, request)
      if (answer.ok !== true) return { ok: false, error: answer.error ?? `answered ${answer.status}` }
      try {
        return { ok: true, status: answer.status, body: JSON.parse(answer.body.toString('utf8')) }
      } catch {
        return { ok: false, error: `environment "${envId}" answered something that is not JSON` }
      }
    },

    /**
     * Fetch a resource and hand its body back whole.
     *
     * Used for file pulls and the byte surface; the relay already streamed it, so holding
     * it here is the caller's explicit choice rather than a property of the transport.
     *
     * @returns `{ ok, status?, headers?, body?, error? }`.
     */
    async bytes(envId, request) {
      return await send(envId, request)
    },

    /** The raw sender, for a caller that wants to decide how to read the answer. */
    send,
  }
}
