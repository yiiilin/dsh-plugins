/**
 * Leaf side of the federation tunnel.
 *
 * This node dials one or more upstreams and keeps a WebSocket to each. Everything that
 * crosses is a **stream**: `open` names the environment it is for, `data` carries opaque
 * bytes, `end` closes it. This module never parses what travels — an HTTP request is just
 * bytes that happen to start with a method name, and it is delivered to a local port
 * where something else understands it.
 *
 * Two consequences worth stating, because both were different before:
 *
 * - A node may hold several upstreams at once. Each gets its own socket, its own reader
 *   and its own reconnect schedule, so one upstream being down does not disturb the
 *   others. Which upstream carries a given stream is decided by the topology table, not
 *   by configuration order.
 * - A stream aimed at *this* node is delivered to a local port by opening a TCP
 *   connection and shovelling bytes. The daemon's own HTTP stack answers it, which is
 *   why nothing here needs to understand HTTP.
 *
 * @module @yiln-dsh/dsh-gateway/federation/agent
 */

import { connect as tcpConnect } from 'node:net'

import WebSocket from 'ws'

import { createClockSync, measure } from './clock.js'
import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from './frames.js'
import { keepAlive } from './keepalive.js'
import { createTopologyView, TOPOLOGY_FRAME } from './topology.js'

/** Reconnect backoff, in milliseconds, capped at the last entry. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/**
 * One upstream link.
 *
 * Separated from the agent because a node with several upstreams needs several of
 * everything — socket, reader, reconnect timer, clock estimate — and sharing any of that
 * would make one link's failure disturb another.
 */
function createUpstream({ url, token, selfName, logger, onTopology, onFrame, onClockSample, onLinkUp }) {
  let socket
  let reader
  /** The keepalive for the current socket; cleared whenever that socket goes away. */
  let heartbeat
  let stopped = false
  let attempts = 0
  let timer
  /** streamId(hex) -> handlers for a stream this node opened toward the upstream. */
  const pending = new Map()

  const clock = createClockSync()

  /** The environment this link reaches, once the topology says so. */
  let peerEnvId = ''

  function target() {
    const base = url.replace(/\/+$/u, '')
    const scheme = base.startsWith('https:') ? 'wss:' : 'ws:'
    const rest = base.replace(/^https?:/u, '')
    // The name travels with the handshake: a node names itself, and no upstream should be
    // inventing one for it.
    const named = selfName === '' ? '' : `&name=${encodeURIComponent(selfName)}`
    const host = process.env.HOSTNAME ?? ''
    const hostPart = host === '' ? '' : `&hostname=${encodeURIComponent(host)}`
    return `${scheme}//${rest}/_tunnel?token=${encodeURIComponent(token)}${named}${hostPart}`
  }

  function schedule() {
    if (stopped) return
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
    attempts += 1
    logger.warn(`federation: ${url} reconnecting in ${delay} ms (attempt ${attempts})`)
    timer = setTimeout(connect, delay)
  }

  function connect() {
    if (stopped) return
    socket = new WebSocket(target(), { handshakeTimeout: 15_000 })
    reader = new FrameReader()

    socket.on('open', () => {
      attempts = 0
      heartbeat = keepAlive(socket, { label: url, logger })
      logger.info(`federation: connected to ${url}`)
    })

    socket.on('message', (data) => {
      let frames
      try {
        frames = reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      } catch (error) {
        logger.warn(`federation: ${url} sent bytes that are not frames: ${error.message}`)
        socket.close()
        return
      }
      // Not per message: a file stream is hundreds of pieces, and a log line for each is
      // pure overhead on the hot path.
      if (frames.length > 1_000) logger.warn(`federation: received ${frames.length} frames in one message`)
      for (const frame of frames) {
        if (frame.type === TOPOLOGY_FRAME) {
          try {
            const table = JSON.parse(frame.payload.toString('utf8'))
            onTopology(table, api)
          } catch (error) {
            logger.warn(`federation: could not read the topology from ${url}: ${error.message}`)
          }
          continue
        }
        const key = frame.id.toString('hex')
        const entry = pending.get(key)
        if (entry === undefined) {
          onFrame(frame, api)
          continue
        }
        if (frame.type === FRAME.data) {
          entry.onData?.(frame.payload)
          continue
        }
        if (frame.type === FRAME.end) {
          clearTimeout(entry.timer)
          pending.delete(key)
          entry.onEnd?.()
        }
      }
    })

    socket.on('close', () => {
      // The interval outlives the socket otherwise, which keeps the process alive for a
      // tunnel that no longer exists.
      heartbeat?.stop()
      heartbeat = undefined
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.onClose?.()
      }
      pending.clear()
      socket = undefined
      schedule()
    })

    socket.on('error', (error) => {
      logger.warn(`federation: ${url}: ${error.message}`)
    })
  }

  /** The handle `onFrame` receives, so a stream is answered on the link it came from. */
  const api = {
    url,
    /**
     * The environment on the other end of this link.
     *
     * Learned from the topology push, because a leaf knows only its token. The hub needs
     * it to name the peer a relayed stream came from; a route keyed by URL found nothing
     * when the answer arrived.
     */
    get envId() {
      return peerEnvId
    },
    /** Remember which environment this link reaches. */
    adoptPeer(envId) {
      peerEnvId = envId
    },
    clock,
    start() {
      stopped = false
      connect()
    },
    stop() {
      stopped = true
      heartbeat?.stop()
      heartbeat = undefined
      clearTimeout(timer)
      try {
        // Terminate, not close: a close waits for the peer, and shutdown must not depend
        // on the other end answering. The raw socket underneath is destroyed as well,
        // because terminating the WebSocket layer alone leaves the TCP socket open and the
        // process alive.
        socket?.terminate()
        socket?._socket?.destroy()
      } catch {
        // Already gone.
      }
      socket = undefined
    },
    get connected() {
      return socket !== undefined && socket.readyState === WebSocket.OPEN
    },
    /** Send raw bytes on a stream toward the upstream. */
    send(socketFrame) {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
      try {
        socket.send(socketFrame)
        return true
      } catch {
        return false
      }
    },
    /**
     * Open a stream toward this upstream and collect the answer.
     *
     * @returns `{ ok: true, send, end, id }` or `{ ok: false, error }`.
     */
    openStream(toEnvId, { sink, onEnd, onError, target, timeoutMs = 300_000 }) {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        return { ok: false, error: `upstream ${url} is not connected` }
      }
      const id = newRequestId()
      const key = id.toString('hex')
      pending.set(key, {
        onData: sink,
        onEnd,
        onError,
        timer: setTimeout(() => {
          pending.delete(key)
          onError?.(`${url} did not answer in time`)
        }, timeoutMs),
      })
      // The far side is told where to attach; absent means that node's daemon.
      socket.send(encodeJsonFrame(FRAME.open, id, target === undefined ? { toEnvId } : { toEnvId, target }))
      return {
        ok: true,
        id,
        send(piece) {
          if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
          socket.send(encodeFrame(FRAME.data, id, piece))
          return true
        },
        end() {
          if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
          socket.send(encodeFrame(FRAME.end, id))
          return true
        },
      }
    },
    /**
     * Report this node's view upstream.
     *
     * Every link reports, not only those below: a parent that never hears from a child
     * believes the child's subtree is the child alone.
     *
     * @param table - what to send; nothing is sent when undefined.
     */
    reportTopology(table) {
      if (table === undefined) return false
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
      try {
        socket.send(encodeJsonFrame(TOPOLOGY_FRAME, Buffer.alloc(16), table))
        return true
      } catch {
        return false
      }
    },
    /** Record one clock exchange; the best round trip wins. */
    addClockSample(sample) {
      const estimate = clock.add(sample)
      if (estimate !== undefined) onClockSample?.(estimate)
    },
  }
  return api
}

/**
 * The leaf's tunnel to its upstreams.
 *
 * @param options.upstreams - `[{ url, token }]`; one link each.
 * @param options.harnessPort - the local listener that answers harness requests.
 * @param options.daemonPort - the local daemon that answers `/admin` and `/file`.
 * @param options.logger - logger.
 * @param options.selfName - the name this node claims for itself.
 * @returns `{ start, stop, connected, topology, linkTo, openStream }`.
 */
export function createTunnelAgent({ upstreams = [], harnessPort, daemonPort, logger, selfName = '' }) {
  /** streamId(hex) -> the local socket a stream aimed at this node is delivered to. */
  const localStreams = new Map()

  /** streamId(hex) -> the hub handler forwarding a stream aimed past this node. */
  const relayed = new Map()

  /**
   * Asked before a stream is attached locally: is it for this node, or beyond it?
   *
   * Supplied by the gateway, which owns the routing table.
   */
  let routeQuery

  const topology = createTopologyView({})
  const claimedName = selfName === '' ? (process.env.HOSTNAME ?? '') : selfName

  const links = upstreams.map((upstream) => createUpstream({
    url: upstream.url,
    token: upstream.token,
    selfName: claimedName,
    logger,
    onTopology(table, owner) {
      if (owner !== undefined && typeof table?.from === 'string' && table.from !== '') {
        owner.adoptPeer(table.from)
      }
      // The upstream says which environment this edge is; a leaf knows only its token.
      if (typeof table?.selfEnvId === 'string' && table.selfEnvId !== '') {
        topology.setSelfId(table.selfEnvId)
      }
      // Attribute the table to the link it arrived on, so its sequence numbers order
      // separately from another upstream's.
      const adopted = topology.apply(table, { source: owner?.url })
      logger.info(`federation: topology ${adopted ? 'updated' : 'ignored stale'} (seq ${table?.seq}, ${table?.nodes?.length ?? 0} node(s))`)
      if (adopted) announce(owner)
    },
    onFrame(frame, owner) {
      // A frame for a stream this node never opened: either an `open` addressed to this
      // node, or the body of one already attached to a local port.
      if (frame.type === FRAME.open) {
        let payload
        try {
          payload = JSON.parse(frame.payload.toString('utf8'))
        } catch (error) {
          logger.warn(`federation: an upstream opened a stream with invalid JSON: ${error.message}`)
          return
        }
        // A node that both accepts and dials is the middle of a chain. An `open` arriving
        // here may be for this node or beyond it, and the hub is the half that knows:
        // without asking, every relayed stream was delivered to the middle of the chain.
        const verdict = routeQuery?.(payload?.toEnvId, owner)
        if (verdict?.forward === true) {
          if (verdict.handle === undefined) {
            logger.warn(`federation: no route for a stream to "${payload?.toEnvId}"`)
            return
          }
          relayed.set(frame.id.toString('hex'), verdict.handle)
          verdict.handle(frame, owner)
          return
        }
        attachLocalStream(frame.id, payload, owner)
        return
      }
      if (frame.type === FRAME.data) {
        const relay = relayed.get(frame.id.toString('hex'))
        if (relay !== undefined) {
          relay(frame, owner)
          return
        }
        writeLocal(frame.id, frame.payload)
        return
      }
      if (frame.type === FRAME.end) {
        const relay = relayed.get(frame.id.toString('hex'))
        if (relay !== undefined) {
          relayed.delete(frame.id.toString('hex'))
          relay(frame, owner)
          return
        }
        endLocal(frame.id)
      }
    },
    onLinkUp() {
      // A fresh link needs the current view, and the parent must hear about this subtree
      // or it will believe the subtree is one node.
      announce()
    },
    onClockSample(estimate) {
      logger.info(`federation: clock offset to ${upstream.url} is ${Math.round(estimate.offset)} ms (rtt ${Math.round(estimate.rtt)} ms)`)
    },
  }))

  /**
   * Tell every upstream what this node knows, except what it learned from that one.
   *
   * The exception is split-horizon: echoing a peer's own report back is what would keep a
   * loop circulating. Withholding terminates propagation — no hop limit, no visited set.
   *
   * @param origin - the link a table just arrived on; omitted for a local change.
   */
  function announce(origin) {
    for (const one of links) {
      if (one === origin) continue
      const table = topology.outbound({ exclude: one.url })
      const sent = one.reportTopology(table)
      if (table !== undefined) {
        logger.info(`federation: reporting ${table.nodes.length} node(s) to ${one.url}${sent ? '' : ' (link not open)'}`)
      }
    }
  }

  /**
   * Deliver a stream aimed at this node to one of its own ports.
   *
   * Bytes are shovelled into a TCP connection and answered back the same way. This is why
   * the tunnel needs no idea what the protocol is: the listener on the far side of this
   * connection already knows.
   */
  function attachLocalStream(id, payload, owner) {
    const key = id.toString('hex')
    // Where to attach is the *far* node's decision, because only it knows its own ports.
    // A caller names what it wants — `harness` for the profile's own web UI, nothing for
    // the daemon — and this node resolves that to a port. Sending a number instead could
    // not work: the caller has no way to learn a peer's port numbers, and the first
    // version's silent fallback to the daemon made every proxied upgrade land on the
    // admin surface and come back as a login page.
    const wantsHarness = payload?.target === 'harness'
    const requested = Number(payload?.port)
    const resolved = Number.isInteger(requested) && requested > 0
      ? requested
      : (wantsHarness ? harnessPort() : daemonPort())
    const port = resolved
    if (port === 0) {
      logger.warn('federation: a stream arrived before the local listener existed')
      return
    }
    const client = tcpConnect({ host: '127.0.0.1', port }, () => {
      logger.info(`federation: stream ${key.slice(0, 8)} attached to 127.0.0.1:${port}`)
    })
    localStreams.set(key, client)
    // Answers go back on the link the stream arrived on, not on whichever link happens to
    // be first: with several upstreams, replying on the wrong one would deliver the
    // answer to a node that never asked.
    client.on('data', (piece) => {
      logger.info(`federation: local stream ${key.slice(0, 8)} answered ${piece.length} byte(s)`)
      owner.send(encodeFrame(FRAME.data, id, piece))
    })
    client.on('end', () => {
      localStreams.delete(key)
      owner.send(encodeFrame(FRAME.end, id))
    })
    client.on('error', (error) => {
      logger.warn(`federation: local stream to 127.0.0.1:${port} failed: ${error.message}`)
      localStreams.delete(key)
      owner.send(encodeFrame(FRAME.end, id))
    })
  }

  /**
   * Feed bytes that arrived for a local stream into its TCP connection.
   *
   * Called from the frame dispatcher, which knows the stream id; the connection was
   * created when the `open` arrived.
   */
  function writeLocal(id, piece) {
    const client = localStreams.get(id.toString('hex'))
    if (client === undefined) return
    client.write(piece)
  }

  /** Close the local connection for a stream the far end finished. */
  function endLocal(id) {
    const key = id.toString('hex')
    const client = localStreams.get(key)
    if (client === undefined) return
    localStreams.delete(key)
    client.end()
  }

  return {
    start() {
      for (const one of links) one.start()
    },
    /**
     * Report this node's view to every upstream.
     *
     * @param options.view - a richer view to report from; the hub has one that folds in
     *   what its own children reported, which the agent's view does not contain.
     */
    announce({ view } = {}) {
      for (const one of links) {
        const table = (view ?? topology).outbound({ exclude: one.url })
        if (table === undefined) continue
        one.reportTopology(table)
      }
    },
    stop() {
      for (const one of links) one.stop()
      for (const [, client] of localStreams) client.destroy()
      localStreams.clear()
    },
    get connected() {
      return links.some((one) => one.connected)
    },
    topology,
    /** The links, for diagnostics. */
    links,
    /**
     * Which upstream carries a stream to `envId`, from the pushed table.
     *
     * `{ local: true }` means the destination is this node. Otherwise the returned link
     * has `openStream(envId, …)`, so a caller never has to know whether the transport is
     * one upstream or several.
     */
    linkTo(envId) {
      const route = topology.routeTo(envId)
      if (route === undefined) return undefined
      if (route.done === true) return { local: true }
      // `via` names the environment to hand the stream to. Every link reaches the
      // upstream that published the table, so any connected one will do today; when a
      // node holds several upstreams that see different parts of the graph, this is where
      // the choice becomes meaningful.
      return links.find((one) => one.connected)
    },
    writeLocal,
    endLocal,
    /**
     * How this node decides whether an arrived stream is for it or beyond it.
     *
     * @param handler - `(toEnvId, owner) => { forward: boolean, handle? }`.
     */
    setRouteQuery(handler) {
      routeQuery = handler
    },
    /** How many locally-attached streams are open; for tests and shutdown checks. */
    get localStreamCount() {
      return localStreams.size
    },
  }
}
