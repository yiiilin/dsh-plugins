/**
 * A local TCP port that forwards to a remote environment through the tunnel.
 *
 * This is the adapter that keeps the tunnel a byte pipe. A caller that wants to talk to
 * another environment's daemon opens an ordinary HTTP request against a loopback port
 * allocated here; the bytes travel through a tunnel stream and come out of a TCP
 * connection on the far side, where the daemon's own HTTP stack answers them. Neither
 * side's HTTP is reimplemented, and the tunnel never parses anything.
 *
 * The alternative — writing an HTTP client over the tunnel by hand — was tried first and
 * is worse in a specific way: it means parsing status lines, headers, `content-length`
 * and chunked bodies here, duplicating what Node already does correctly, and every
 * protocol added later would need the same work again.
 *
 * One port per destination: the port *is* the routing decision, so a connection needs no
 * header inspected to know where it goes. Ports are allocated on first use and reused.
 *
 * @module @yiln-dsh/dsh-gateway/stream-relay
 */

import { createServer } from 'node:net'

/** First port to try for a target; the OS picks the actual one. */
const ANY_PORT = 0

/**
 * Build the relay.
 *
 * @param options.logger - logger.
 * @param options.openStream - `(envId, { sink, onEnd }) => { ok, send, end }`; opens a
 *   tunnel stream toward one environment.
 * @param options.sinkPort - the port the far side should attach to; `undefined` means the
 *   far side's default (its daemon).
 * @returns `{ portFor, close }`.
 */
export function createStreamRelay({ logger, openStream, sinkPort }) {
  /** envId -> the loopback port that forwards to it. */
  const ports = new Map()
  /** envId -> a promise of the port, so two callers do not race a second listener. */
  const pending = new Map()
  /** Every listener, for shutdown. */
  const servers = new Map()

  /** Every accepted client socket, so shutdown does not leave half-open connections. */
  const clients = new Set()

  /**
   * Open the listener for one environment.
   *
   * @returns a promise of the loopback port, or `undefined` when it could not listen.
   */
  function listenFor(envId) {
    return new Promise((resolve) => {
      const server = createServer((client) => {
        logger.info(`federation: relay accepted a connection for "${envId}"`)
        clients.add(client)
        client.on('close', () => clients.delete(client))
        logger.info(`federation: relay opening a stream for "${envId}"`)
        const opened = openStream(envId, {
          sink(piece) {
            // The far end's answer comes back as bytes; hand them to the local caller.
            logger.info(`federation: relay to "${envId}" got ${piece.length} byte(s), client destroyed=${client.destroyed} writable=${client.writable}`)
            logger.info(`federation: relay bytes: ${JSON.stringify(piece.subarray(0, 60).toString('latin1'))}`)
            if (!client.destroyed) client.write(piece)
          },
          onEnd() {
            logger.info(`federation: relay to "${envId}" finished`)
            client.end()
          },
          onError(error) {
            logger.warn(`federation: relay to "${envId}" failed: ${error}`)
            client.destroy()
          },
        })
        if (opened.ok !== true) {
          logger.warn(`federation: relay to "${envId}": ${opened.error}`)
          client.destroy()
          return
        }
        // The request travels the other way, as bytes.
        client.on('data', (piece) => opened.send(piece))
        // Half-close only. The local caller finishing its request says nothing about the
        // answer: an HTTP client sends the whole request and then waits, so closing the
        // stream here ended it before a single response byte could come back. That is why
        // every relayed request timed out while the far side answered correctly.
        let requestDone = false
        const finishRequest = () => {
          if (requestDone) return
          requestDone = true
          opened.end()
        }
        client.on('end', finishRequest)
        client.on('error', () => opened.end())
        // A caller that goes away entirely must not leave the far side working for nobody.
        client.on('close', () => {
          clients.delete(client)
          if (!requestDone) opened.end()
        })
      })
      // Settled at most once, whichever comes first. A `listen` that neither succeeds nor
      // errors would otherwise leave every caller waiting forever — and a promise that
      // never settles is worse than a refusal, because nothing downstream can react.
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        clearTimeout(guard)
        resolve(value)
      }
      const guard = setTimeout(() => {
        logger.warn(`federation: relaying to "${envId}" did not start listening; giving up`)
        servers.delete(server)
        try {
          server.close()
        } catch {
          // Never listened.
        }
        settle(undefined)
      }, 10_000)
      guard.unref?.()

      server.on('error', (error) => {
        logger.warn(`federation: could not relay to "${envId}": ${error.message}`)
        ports.delete(envId)
        settle(undefined)
      })
      server.listen(ANY_PORT, '127.0.0.1', () => {
        const { port } = server.address()
        logger.info(`federation: relay for "${envId}" listening on 127.0.0.1:${port}`)
        servers.set(port, server)
        settle(port)
      })
    })
  }

  return {
    /**
     * The loopback port that reaches `envId`.
     *
     * @returns a promise of the port, or `undefined` when no listener could be opened.
     */
    async portFor(envId) {
      const known = ports.get(envId)
      if (known !== undefined) return known
      const racing = pending.get(envId)
      if (racing !== undefined) return racing
      const opening = listenFor(envId).then((port) => {
        pending.delete(envId)
        if (port === undefined) return undefined
        // The far side attaches to `sinkPort`; it learns which one from the open frame.
        ports.set(envId, port)
        return port
      })
      pending.set(envId, opening)
      return opening
    },

    /** The port the far end should attach to, as the open frame asks. */
    get sinkPort() {
      return sinkPort
    },

    /** Stop every listener and forget the ports. */
    close() {
      // Close the accepted sockets first: `server.close()` only stops accepting, and a
      // live connection keeps the process alive after the listener is gone.
      for (const client of clients) client.destroy()
      clients.clear()
      for (const [, server] of servers) {
        try {
          server.close()
        } catch {
          // Already closing.
        }
      }
      servers.clear()
      ports.clear()
      pending.clear()
    },
  }
}
