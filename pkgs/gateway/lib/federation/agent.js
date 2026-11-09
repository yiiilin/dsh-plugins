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
function createUpstream({ url, token, selfName, harnessPort, envId, logger, onTopology, onFrame, onClockSample, onLinkUp }) {
  let socket
  let reader
  /** The keepalive for the current socket; cleared whenever that socket goes away. */
  let heartbeat
  /**
   * This link's connection state, as a table.
   *
   * It used to be implied by `stopped`, `attempts` and whether `timer` was set, and those
   * three answered different questions about the same thing. `attempts` in particular meant
   * both "how many failures have there been" and "am I connected" — resetting it on `open`
   * meant a link that connects and immediately drops restarted its backoff from one second
   * every time, so a flapping upstream retried for ever at full speed.
   *
   * An event with no entry leaves the state unchanged, so a socket callback from a
   * superseded connection cannot resurrect this one.
   *
   * - `open`    — the socket's handshake completed.
   * - `drop`    — the socket closed, or an error left it unusable.
   * - `stop`    — teardown, after which nothing schedules another attempt.
   */
  const LINK_TRANSITIONS = {
    idle: { open: 'connected', drop: 'backoff', stop: 'stopped' },
    connected: { drop: 'backoff', stop: 'stopped' },
    backoff: { open: 'connected', drop: 'backoff', stop: 'stopped' },
    stopped: {},
  }

  let linkState = 'idle'
  /** Consecutive failures, kept across a reconnect so the delay actually grows. */
  let attempts = 0
  let timer
  /** streamId(hex) -> handlers for a stream this node opened toward the upstream. */
  const pending = new Map()
  /** Streams carried by this link, so a close can fail all of them. */
  const linkStreams = new Set()

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
    // The listener this node's own UI answers on. A peer needs it to address the mux
    // socket and to sign a session cookie the browser will accept, and nothing else can
    // supply it — a port number cannot be derived, and the topology table does not carry
    // it for a direct peer.
    const port = typeof harnessPort === 'function' ? harnessPort() : 0
    const portPart = port > 0 ? `&harnessPort=${port}` : ''
    // This node's own id, declared at the door. An environment id is unique and generated
    // by the machine it names, so the node that owns it is the only authority on it — the
    // upstream records what it is told rather than assigning one. Two identities for one
    // node (a registry id here, a different one in the topology) is what put every
    // neighbour list one hop out of step.
    const id = typeof envId === 'function' ? envId() : ''
    const idPart = typeof id === 'string' && id !== '' ? `&envId=${encodeURIComponent(id)}` : ''
    return `${scheme}//${rest}/_tunnel?token=${encodeURIComponent(token)}${named}${hostPart}${portPart}${idPart}`
  }

  /**
   * Move to `event` and report the state it lands in.
   *
   * @param event - one of the events named on the table.
   * @returns the state after the event.
   */
  function advance(event) {
    const row = LINK_TRANSITIONS[linkState]
    const next = row === undefined ? undefined : row[event]
    if (typeof next === 'string') linkState = next
    return linkState
  }

  function schedule() {
    if (advance('drop') === 'stopped') return
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
    attempts += 1
    logger.warn(`federation: ${url} reconnecting in ${delay} ms (attempt ${attempts})`)
    timer = setTimeout(connect, delay)
  }

  function connect() {
    if (linkState === 'stopped') return
    socket = new WebSocket(target(), { handshakeTimeout: 15_000 })
    reader = new FrameReader()

    socket.on('open', () => {
      // The delay resets only when a connection has *stayed* up; see the table.
      attempts = 0
      advance('open')
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
      connect()
    },
    stop() {
      advance('stop')
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
    /**
     * This link in the shape the hub's records take.
     *
     * The hub opens streams on a record with `socket.send` and a `streams` set. A dialled
     * link is the same channel, so it answers the same two fields — one implementation
     * serves both directions instead of one per side.
     */
    asRecord() {
      return {
        envId: peerEnvId,
        socket: {
          // Guarded: a link can drop between the lookup and the send, and an unguarded
          // call here took the whole process down.
          send(bytes) {
            if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
            socket.send(bytes)
            return true
          },
          get readyState() {
            return socket === undefined ? WebSocket.CLOSED : socket.readyState
          },
        },
        streams: linkStreams,
      }
    },
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
export function createTunnelAgent({ upstreams = [], harnessPort, daemonPort, envId, logger, selfName = '' }) {
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

  // Empty for the same reason as the hub's: an edge learns its id from its upstream. It is
  // filled in by `setSelfId` on the first topology it receives.
  const topology = createTopologyView({})

  /** Sockets opened to answer streams addressed to this node. */
  const localAnswerSockets = new Set()

  /** Called after each applied message, so the hub's view can follow this one. */
  let topologySink

  /**
   * The neighbour list last sent upstream.
   *
   * Replying to a message that taught nothing new would otherwise re-advertise on every
   * round: each advertisement carries a fresh counter, so the far side always treats it as
   * news and answers, and the two nodes trade messages for ever. Measured at 542 in two
   * minutes before this guard.
   */
  let lastAnnounced = ''
  const claimedName = selfName === '' ? (process.env.HOSTNAME ?? '') : selfName

  const links = upstreams.map((upstream) => createUpstream({
    url: upstream.url,
    token: upstream.token,
    selfName: claimedName,
    harnessPort,
    envId,
    logger,
    onTopology(table, owner) {
      const learned = owner !== undefined && typeof table?.from === 'string' && table.from !== ''
      if (learned) owner.adoptPeer(table.from)
      // The upstream says which environment this edge is; a leaf knows only its token.
      if (typeof table?.selfEnvId === 'string' && table.selfEnvId !== '') {
        topology.setSelfId(table.selfEnvId)
      }
      // Learn every advertisement the message carries. Flood-per-origin: each is stored
      // under the node it describes, so two upstreams reporting different parts of the
      // graph add up instead of overwriting one another. This node's own entry is skipped
      // — it knows its own links first-hand, and adopting a peer's view of them would let
      // a stale report outlive the link it described.
      let adopted = false
      for (const state of Array.isArray(table?.states) ? table.states : []) {
        if (state?.envId === topology.selfId) continue
        if (topology.learn(state)) adopted = true
      }
      for (const row of Array.isArray(table?.nodes) ? table.nodes : []) {
        if (row?.envId === topology.selfId) continue
        if (topology.describe(row)) adopted = true
      }
      logger.info(`federation: topology ${adopted ? 'updated' : 'unchanged'} (${Array.isArray(table?.states) ? table.states.length : 0} state(s), ${Array.isArray(table?.nodes) ? table.nodes.length : 0} node(s))`)
      // Re-announce when the link's identity was just learned: the advertisement this node
      // sent on link-up listed its neighbours by id, and it had no id for this one yet. The
      // result was an empty neighbour set reaching every other node, which made this node a
      // dead end in their graph — reachable by name, with no path to it.
      // Hand what was learned to the hub, whose view is the one `relay` routes with.
      // This is the only path a dialer's topology takes: it never receives a report, so
      // without it the hub stayed empty and answered "no route" for a peer the agent
      // could already reach.
      if (adopted) {
        // This node's own advertisement is included: `advertisements()` holds only what
        // was learned from peers, and the hub needs the origin's own links to walk a path
        // that starts here. A dialer has no table of its own to supply them.
        topologySink?.({
          states: [...topology.advertisements(), topology.selfAdvertisement(upstreamLinks())],
          nodes: topology.nodes(),
        })
      }
      // Back to the link it came from as well. A node with a single upstream — every leaf —
      // otherwise had nobody to answer: skipping the origin left the loop with no targets,
      // so its own advertisement never went out and the upstream's table listed it with no
      // neighbours. The message carries this node's own links, not the ones just received,
      // so it does not echo what it was told.
      if (adopted || learned) announce()
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
  /** The environments this node holds a live direct link to. */
  function upstreamLinks() {
    return links.filter((link) => link.connected).map((link) => link.envId).filter((id) => typeof id === 'string' && id !== '')
  }

  function announce(origin) {
    for (const one of links) {
      if (one === origin) continue
      // Withheld by *id*, not URL: the exclude set is compared against environment ids, and
      // a URL never matches one — which silently disabled split horizon.
      const attached = links.filter((link) => link.connected).map((link) => link.envId).filter((id) => typeof id === 'string' && id !== '')
      // Silent when nothing changed. `force` is not offered on purpose: an announcement
      // exists to tell upstreams about this node's links, and re-sending the same list is
      // what makes two nodes answer each other indefinitely.
      const signature = attached.join(',')
      if (signature === lastAnnounced) continue
      lastAnnounced = signature
      const table = topology.outbound({
        exclude: one.envId ?? '',
        // The view's counter, not a local one: this node also speaks from the hub, and two
        // counters made its advertisements arrive in an order no receiver could apply.
        self: topology.selfAdvertisement(attached),
      })
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
      logger.info(`federation: local stream ${key.slice(0, 8)} ended by the daemon`)
      localStreams.delete(key)
      owner.send(encodeFrame(FRAME.end, id))
    })
    client.on('close', () => {
      logger.info(`federation: local stream ${key.slice(0, 8)} closed`)
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
    const key = id.toString('hex')
    const client = localStreams.get(key)
    if (client === undefined) return
    client.write(piece)
  }

  /** Close the local connection for a stream the far end finished. */
  function endLocal(id) {
    const key = id.toString('hex')
    const client = localStreams.get(key)
    if (client === undefined) return
    // Nothing is closed here. A stream's `end` means "the caller has finished sending",
    // and for HTTP that happens before the answer exists — closing on it discarded every
    // response that took longer than its request, which is exactly why a small
    // `/admin/state` worked while `/admin/remote-sessions` came back empty. The socket is
    // closed when the daemon ends it (`client.on('end')`), which is the real end of the
    // exchange.
    client.write(Buffer.alloc(0))
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

      // The route names the neighbour to hand the stream to. It is chosen from the graph,
      // not from whichever link happens to be up: with several upstreams only one of them
      // may lead where the stream is going.
      //
      // A next hop that is not one of this node's own upstreams is a node reached *back*
      // through a link — the stream goes to the upstream that advertised it, and the
      // packet's `toEnvId` carries it the rest of the way.
      const wanted = route.next ?? ''
      if (wanted !== '') {
        const named = links.find((one) => one.connected && one.envId === wanted)
        if (named !== undefined) return named
      }
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

    /**
     * One of this node's dialled links, shaped the way the hub's own records are.
     *
     * The hub opens streams on records; a dialled link is the same full-duplex channel as
     * an accepted one, so it answers the same two fields — `socket.send` and a `streams`
     * set. Exposing it is what lets one code path serve both directions.
     *
     * @param envId - the environment the link reaches.
     * @returns the record, or `undefined` when no link reaches it.
     */
    outboundRecord(envId) {
      const link = links.find((one) => one.connected && one.envId === envId)
      if (link === undefined) return undefined
      return link.asRecord()
    },

    /**
     * Answer a stream addressed to this node by connecting it to a local port.
     *
     * Exposed so the hub can install it: a stream arriving here belongs to this node, and
     * the hub has no way to open a socket on its behalf.
     *
     * @param id - the stream's id, as a hex key.
     * @param payload - the `open` payload naming `target` or `port`.
     * @param owner - the link the stream arrived on, so the answer goes back the same way.
     */
    /**
     * Answer a stream addressed to this node: connect it to the port it names and pump the
     * bytes both ways.
     *
     * The hub owns the wire, so it supplies `write`/`end`; this side owns the socket.
     *
     * @param payload - the `open` payload naming `target` or `port`.
     * @param sink - `{ write(piece), end() }`, provided by the hub.
     */
    answerLocalStream(payload, sink) {
      const wantsHarness = payload?.target === 'harness'
      const requested = Number(payload?.port)
      const port = Number.isInteger(requested) && requested > 0
        ? requested
        : (wantsHarness ? harnessPort() : daemonPort())
      if (port === 0) {
        logger.warn('federation: a stream arrived before the local listener existed')
        sink.end()
        return
      }
      const client = tcpConnect({ host: '127.0.0.1', port }, () => {
        logger.info(`federation: answered a stream on 127.0.0.1:${port}`)
      })
      client.on('data', (piece) => sink.write(piece))
      client.on('end', () => sink.end())
      client.on('error', (error) => {
        logger.warn(`federation: answering on ${port} failed: ${error.message}`)
        sink.end()
      })
      // Registered through the sink, not assigned on it: the hub holds the stream entry and
      // needs the writer to reach the socket this function just opened.
      sink.accept((piece) => {
        if (piece === undefined) {
          client.end()
          return
        }
        client.write(piece)
      })
      localAnswerSockets.add(client)
      client.on('close', () => localAnswerSockets.delete(client))
    },

    /**
     * Be told about every advertisement this agent learns.
     *
     * The hub keeps its own view, and it is the one `relay` routes with. A dialer never
     * receives a report — its topology arrives as frames — so without this the hub's view
     * stayed empty and every stream toward an upstream answered "no route", even though
     * the agent's own view knew the way.
     *
     * @param handler - `({ states, nodes }) => void`, called after a message is applied.
     */
    setTopologySink(handler) {
      topologySink = handler
    },
    /** How many locally-attached streams are open; for tests and shutdown checks. */
    get localStreamCount() {
      return localStreams.size
    },
  }
}
