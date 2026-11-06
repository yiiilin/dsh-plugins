/**
 * Liveness for one tunnel socket.
 *
 * A tunnel can die without either end noticing. When a link between two machines drops
 * silently — a NAT table entry expiring, a Wi-Fi hop going away, a firewall forgetting
 * a flow — no FIN or RST reaches this side, so `close` never fires. Both processes then
 * keep a socket they believe is open, and the edge never reconnects, because its
 * reconnect lives on `close`. That is exactly how a healthy edge sat unreachable for
 * 49 hours: the TCP socket was still ESTABLISHED with `lastrcv` two days old.
 *
 * The fix is a protocol-level ping, not an application frame. `ws` answers a ping with
 * a pong inside the library, so a peer that is alive but running older code still
 * answers, and a peer that is gone answers nothing. That also keeps the wire format
 * unchanged, so a mixed-version pair stays compatible.
 *
 * @module @yiln-dsh/dsh-gateway/federation/keepalive
 */

/** How often to ping a socket that is otherwise quiet. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * How long a socket may stay silent before it is presumed dead.
 *
 * Three missed pings. Long enough that a slow link or one dropped packet is not a
 * disconnect; short enough that a dead edge is replaced in minutes rather than days.
 */
export const HEARTBEAT_TIMEOUT_MS = 90_000

/**
 * Watch one socket and terminate it once its peer stops answering.
 *
 * Any inbound traffic counts as proof of life, not only pongs: a busy tunnel sends
 * request frames constantly and needs no ping at all.
 *
 * @param socket - the `ws` socket, on either side of the tunnel.
 * @param options.label - names this side in the warning, e.g. `federation: env-a`.
 * @param options.logger - logger.
 * @param options.intervalMs - ping cadence.
 * @param options.timeoutMs - silence that means dead.
 * @returns `{ stop }`; calling `stop` is required before dropping the socket by hand.
 */
export function keepAlive(socket, {
  label,
  logger,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  timeoutMs = HEARTBEAT_TIMEOUT_MS,
}) {
  let lastSeen = Date.now()
  const touch = () => { lastSeen = Date.now() }

  const timer = setInterval(() => {
    const silentMs = Date.now() - lastSeen
    if (silentMs > timeoutMs) {
      // `terminate` rather than `close`: a half-open socket ignores a graceful close
      // handshake, and waiting for one is what already failed. This fires `close`, which
      // is what the edge's reconnect and the hub's cleanup are both waiting for.
      logger.warn(`federation: ${label} silent for ${Math.round(silentMs / 1000)}s; dropping the socket so a reconnect can replace it`)
      clearInterval(timer)
      socket.terminate()
      return
    }
    try {
      socket.ping()
    } catch {
      // A socket already closing is not an error worth reporting; the `close` handler
      // does the cleanup.
    }
  }, intervalMs)
  // A watcher must never be the reason the process stays alive.
  timer.unref?.()

  socket.on('pong', touch)
  socket.on('message', touch)

  const stop = () => clearInterval(timer)
  socket.on('close', stop)
  return { stop }
}
