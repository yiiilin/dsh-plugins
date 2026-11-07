/**
 * Main-node side of the federation tunnel.
 *
 * The tunnel is a **byte pipe**: it moves streams from one environment to another and
 * understands nothing inside them. HTTP, gRPC, a bare TCP protocol — all arrive here as
 * `open` / `data` / `end`, and this module only decides which socket to put each stream
 * on. Request/response semantics live in the node that ends up opening the local
 * connection.
 *
 * Edges dial out and keep one WebSocket each; the main node never dials an edge, so an
 * edge needs no inbound port open. Because the main node is the only node holding every
 * tunnel, it is also the node that relays one edge's stream to another — an edge talks to
 * a peer through here rather than to it directly.
 *
 * Trust model: a connection is authenticated once, by the environment token, and only
 * the edge can be on the other end. A stream arriving *from* an edge is therefore already
 * attributed to that environment — no cookie, header or signature is consulted.
 *
 * @module @yiln-dsh/dsh-gateway/federation/hub
 */

import { WebSocketServer } from 'ws'

import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from './frames.js'
import { keepAlive } from './keepalive.js'
import { createTopologyView, linkState, nodeRow, TOPOLOGY_FRAME } from './topology.js'

/** Path the edges connect to. */
export const TUNNEL_PATH = '/_tunnel'

/**
 * The environment id meaning "this node".
 *
 * Shared with the admin API's own overview, which reports this node under the same id,
 * so a caller that learned the id from one service can use it in the other.
 */
export const SELF_ENV_ID = 'self'

/**
 * Accept and manage edge connections.
 *
 * @param options.verifyToken - `(token) => environment | undefined`; resolves the
 *   environment an edge claims to be, or nothing when the token is unknown.
 * @param options.logger - logger.
 * @param options.deliver - `(message) => Promise<{ok, error?}>`; puts one message into a
 *   session **on this machine**. Supplied by the gateway so the tunnel stays a transport
 *   and never learns how a session is reached.
 * @param options.forward - `(toEnvId, message) => Promise<{ok, error?}>`; sends a message
 *   to another edge through this node. Absent on an edge, which forwards nothing.
 * @param options.listNodes - the node table this hub broadcasts; absent when this hub is
 *   not the authority.
 * @returns the hub: `accept`, `openStream`, `sendAgentMessage`, `isOnline`, `ids`,
 *   `broadcastTopology`, `close`.
 */
export function createTunnelHub({ verifyToken, logger, deliver, forward, listEnvironments, listNodes, selfEnvId }) {
  /** envId -> connection record. */
  const connections = new Map()

  /**
   * streamId(hex) -> where the stream came from and where it goes.
   *
   * The tunnel does not rewrite ids, so this is the only state a relay hop keeps. A
   * frame's direction follows from which connection it arrived on: a `data` for a known
   * stream that came from A is A's, and belongs on the way to B.
   */
  const routes = new Map()

  /**
   * streamId(hex) -> the two ends this stream joins.
   *
   * One table for every stream the hub carries, whatever the direction or how many hops
   * away the far end is. `routes`, `upstreamStreams` and `relayed` were three tables for
   * the same fact, and a stream crossing a relay node had to be right in all of them —
   * which is why request paths kept completing while answer paths silently broke.
   */
  const flows = new Map()

  /** One reader per local stream, keyed by streamId(hex). */
  const localReaders = new Map()

  /**
   * Record a relayed stream between the link it arrived on and the link it leaves by.
   *
   * The arriving side is an agent link, which has `send` but is not a connection record.
   * Wrapping it keeps one shape for `flows` instead of a union the forwarding loop has to
   * probe at every frame.
   */
  function holdStream(key, arrivalLink, departureRecord) {
    const arrival = {
      envId: arrivalLink.envId,
      socket: { send: (bytes) => arrivalLink.send(bytes) },
    }
    flows.set(key, { fromRecord: arrival, toRecord: departureRecord })
  }

  /**
   * Put one frame on a connection.
   *
   * The frame arrives decoded — the reader returns `{ type, id, payload }` — so it is
   * encoded again for the next hop.
   */
  function forwardFrame(record, frame) {
    try {
      record.socket.send(encodeFrame(frame.type, frame.id, frame.payload))
      return true
    } catch (error) {
      logger.warn(`federation: could not forward a frame to ${record.envId}: ${error.message}`)
      return false
    }
  }

  /**
   * Feed bytes that were "sent" to the local end of a stream.
   *
   * The local end has no socket, so `forwardFrame` cannot put bytes on a wire for it.
   * Reusing the reader keeps one frame format for both ends instead of a second
   * in-process shape that could drift from the real one.
   */
  function receiveLocalAnswerBytes(bytes, key) {
    // One reader per stream. A shared reader interleaves the pieces of every concurrent
    // stream into one buffer, so frame boundaries land in the wrong stream — the symptom is
    // an answer arriving for a request that is still waiting, and the request that owns
    // those bytes never completing.
    let reader = localReaders.get(key)
    if (reader === undefined) {
      reader = new FrameReader()
      localReaders.set(key, reader)
    }
    let frames
    try {
      frames = reader.push(bytes)
    } catch (error) {
      logger.warn(`federation: a local stream received something unreadable: ${error.message}`)
      return
    }
    for (const frame of frames) receiveLocalAnswer(frame, key)
  }

  /**
   * streamId(hex) -> the upstream link a relayed stream arrived on.
   *
   * A relayed stream's answer comes back on this node's own downstream socket, so it has
   * to be returned up the link the request originally arrived on.
   */
  const upstreamStreams = new Map()


  /**
   * What this node's children have reported, folded together.
   *
   * A parent sees only its own tunnels; without this it believes a cascade is exactly as
   * wide as its own links, so a node several hops down shows as offline and no route to it
   * exists. Children report what they know and the authority merges it.
   */
  // The view's `me` starts empty because this node's id is read from disk asynchronously;
  // `setSelfId` below fills it in. Without it the graph had no origin, so every route
  // needed at least one hop through somebody else and a node's own neighbours were
  // invisible to its own routing.
  const reported = createTopologyView({
    selfId: typeof selfEnvId === 'function' ? selfEnvId() : (selfEnvId ?? ''),
  })

  /** Monotonic per sender, so a receiver can discard a late snapshot. */
  let topologySeq = 0

  /**
   * Where the broadcast loop stands.
   *
   * Two booleans used to describe this — `broadcasting` for "a loop is running" and
   * `topologyDirty` for "the table moved under it" — and the pair had a third meaning in
   * combination: `busy + dirty` is what makes the loop go round again. Naming the states
   * puts that in one place, where a re-entrant call has to answer one question instead of
   * setting the right one of two flags.
   *
   * - `idle`    — nothing is running; a call starts a loop.
   * - `busy`    — a loop is running over a table nobody has changed.
   * - `dirty`   — a loop is running and must go round again.
   * - `settled` — a loop finished; the next call starts a fresh one.
   */
  const BUSY_TRANSITIONS = {
    idle: { begin: 'busy' },
    busy: { change: 'dirty', finish: 'settled' },
    dirty: { change: 'dirty', finish: 'settled' },
    settled: { begin: 'busy' },
  }

  let broadcastState = 'idle'

  /**
   * Move the loop to `event` and report where it landed.
   *
   * @param event - one of the events named on the table.
   * @returns the state after the event.
   */
  function advanceBroadcast(event) {
    const row = BUSY_TRANSITIONS[broadcastState]
    const next = row === undefined ? undefined : row[event]
    if (typeof next === 'string') broadcastState = next
    return broadcastState
  }

  /**
   * Build the snapshot this node would tell others about.
   *
   * The main node is the only node holding every tunnel, so it is the authority; a leaf
   * would broadcast a table that omits everything it cannot see.
   *
   * @returns the snapshot, or undefined when this hub was given no source.
   */
  /**
   * This node's own id, taken from the table it broadcasts.
   *
   * A hub has no config of its own; the node table is the one place that knows what this
   * machine is called. Every sender naming itself `self` is what made two upstreams
   * indistinguishable on the wire, so their counters could not be told apart.
   */
  function selfName() {
    // Told, not inferred. It used to be read back out of the node table by looking for a
    // row tagged `self`, which meant every receiver of that table read the same tag as
    // "this is me" — an edge could not see the node it was connected to.
    // Resolved on each use: the value is not known when this hub is constructed.
    const named = typeof selfEnvId === 'function' ? selfEnvId() : selfEnvId
    return typeof named === 'string' && named !== '' ? named : SELF_ENV_ID
  }

  /** This node's own advertisement counter; a receiver keeps the higher of two. */
  let ownSeq = 0

  /** The last table every peer was sent, and how many peers it went to. */
  let lastSent = ''
  let lastSentPeers = -1

  /**
   * This node's own advertisement: the environments it holds a live tunnel to.
   *
   * This is the only fact a node can contribute that nobody else can observe, and it is
   * what every route in the federation is derived from.
   */
  function ownNeighbours() {
    const ids = []
    for (const record of connections.values()) {
      if (typeof record.envId === 'string' && record.envId !== '') ids.push(record.envId)
    }
    return ids
  }

  /**
   * What to send on a link.
   *
   * A node floods the advertisements it holds, not a computed table: every receiver runs
   * the same shortest-path step over the same facts and arrives at the same answer. It
   * cannot go stale, because there is nothing to age — a link that dies stops being
   * advertised, and every route that crossed it disappears on the next walk.
   *
   * @param exclude - the environment the message is going to, withheld from the payload.
   */
  function buildSnapshot(exclude = '') {
    if (listNodes === undefined) return undefined

    // Metadata for everything this node knows, including itself.
    const nodes = listNodes().map((row) => {
      // A node's own name beats whatever the registry was given when it was enrolled:
      // the machine is the authority on what it is called, and two upstreams that typed
      // different labels would otherwise disagree about the same machine.
      const claimed = connections.get(row.envId)?.claimedName
      const label = typeof claimed === 'string' && claimed !== '' ? claimed : row.label
      return nodeRow({ ...row, label }, { online: row.online, selfId: row.envId })
    })
    const seen = new Set(nodes.map((row) => row.envId))
    for (const row of reported.nodes()) {
      if (seen.has(row.envId)) continue
      seen.add(row.envId)
      // Already in wire shape: re-deriving it here recomputed `online` against *this*
      // node's id, so a live node came out offline whenever it was not this node.
      nodes.push(nodeRow(row, { online: row.online !== false }))
    }

    // Every advertisement known here, plus this node's own — which is never withheld,
    // even from a peer it names, because that peer needs to be told who its neighbours are.
    // Other nodes' advertisements are passed on as received; this node's own is rebuilt
    // from its live connections, so it is always current and always its own fact.
    const states = reported.advertisements().filter((state) => state.envId !== selfName())
    // Refreshed on every build: the id is read from disk after this hub is constructed, so
    // the value captured at mount time is empty and the view would keep no origin.
    reported.setSelfId(selfName())
    const mine = reported.selfAdvertisement(ownNeighbours())
    // Kept in the view as well as sent. A node's own links are half of every path that
    // starts here, and `routeTo` walks the graph — without this entry the graph has no
    // edges at the origin, so a direct neighbour resolves but anything one hop further
    // reports "unreachable" while sitting in the table.
    reported.learn(mine)
    const without = states.filter((state) => state.envId !== selfName())
    return { nodes, states: [...without, mine] }
  }

  function broadcastTopology(force = false) {
    // One snapshot per burst, and one sequence number for it.
    //
    // A send can synchronously trigger a `close` on another socket, which calls back into
    // this function. Without coalescing, the inner call would build from the newer table
    // and take the higher sequence, then the outer loop would finish the older snapshot
    // under a lower one — peers would hold a stale table believing it current. So a
    // re-entrant call only marks the burst dirty; the outer call goes round again with
    // the newest table under one new sequence.
    // Checked before moving: `begin` is inert from `busy`, so asking afterwards whether we
    // are busy would answer yes for the re-entrant call too and start a second loop.
    if (broadcastState === 'busy' || broadcastState === 'dirty') {
      advanceBroadcast('change')
      return 0
    }
    advanceBroadcast('begin')
    let sent = 0
    try {
      do {
        // Back to plain `busy` for this pass; anything that changes the table during it
        // moves us to `dirty` and the loop repeats.
        if (broadcastState === 'dirty') broadcastState = 'busy'
        const table = buildSnapshot()
        if (table === undefined) break
        // The message differs per peer only by split horizon, so the unchanged-table guard
        // compares what every peer would actually receive — withholding is part of the
        // content, and a change that only affects one peer must still be sent.
        const serialized = JSON.stringify(table)
        if (force !== true && serialized === lastSent && connections.size === lastSentPeers) break
        lastSent = serialized
        lastSentPeers = connections.size
        topologySeq += 1
        const seq = topologySeq
        for (const [peerId, record] of connections) {
          try {
            // Withhold the peer being told from every neighbour list: an advertisement that
            // names the receiver as the way to reach a node is a message going back the way
            // it came.
            const states = table.states.map((state) => ({
              envId: state.envId,
              neighbours: state.neighbours.filter((one) => one !== peerId),
              seq: state.seq,
            }))
            // Each edge is told which environment it *is*: a leaf knows only its token,
            // and without its own id it cannot tell "the destination is me" from "a peer".
            record.socket.send(encodeJsonFrame(TOPOLOGY_FRAME, Buffer.alloc(16), {
              ...table, states, seq, from: selfName(), selfEnvId: record.envId,
            }))
            sent += 1
          } catch (error) {
            logger.warn(`federation: could not send the topology to ${record.envId}: ${error.message}`)
          }
        }
      } while (broadcastState === 'dirty')
    } finally {
      advanceBroadcast('finish')
    }
    return sent
  }

  /** Broadcast after the current turn, so a report is not answered inside its own handler. */
  let scheduled
  function scheduleBroadcast() {
    if (scheduled !== undefined) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      broadcastTopology()
    }, 50)
    scheduled.unref?.()
  }

  /**
   * Register one edge socket.
   *
   * @returns the connection record, or undefined when the token was rejected.
   */
  /**
   * The id a connected node declared for itself, given what the registry calls it.
   *
   * The two differ by design: the registry holds what an operator typed, the handshake
   * carries what the machine calls itself. Routing only knows the declared one.
   *
   * @param registryId - the registry's stored id.
   * @returns the declared id, or the registry id when that node is not connected.
   */
  function declaredIdFor(registryId) {
    for (const record of connections.values()) {
      if (record.registryId === registryId) return record.envId
    }
    return registryId
  }

  function register(environment, socket, claim = {}) {
    // The node's own id wins. An environment id is unique and generated by the machine it
    // names, so that machine is the only authority on it; the registry's stored id is what
    // an operator typed when enrolling it, and may be a name they preferred. Keeping the
    // typed one produced two identities for one node — the registry knew it by one, the
    // topology by another — and every neighbour list came out one hop wrong.
    const declared = typeof claim.envId === 'string' && claim.envId !== '' ? claim.envId : ''
    const record = {
      envId: declared !== '' ? declared : environment.id,
      /** The registry row this connection was admitted under, whatever it was named. */
      registryId: environment.id,
      socket,
      reader: new FrameReader(),
      /** The name this node declared for itself, if it sent one. */
      claimedName: typeof claim.name === 'string' ? claim.name : '',
      claimedHostname: typeof claim.hostname === 'string' ? claim.hostname : '',
      /** The peer's own UI listener, declared at handshake because nothing else knows it. */
      claimedHarnessPort: Number(claim.harnessPort) || 0,
      /** streamIds opened by this edge, so a close can fail all of them. */
      streams: new Set(),
    }

    socket.on('message', (data) => {
      let frames
      try {
        frames = record.reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      } catch (error) {
        logger.warn(`federation: ${record.envId} sent bytes that are not frames: ${error.message}`)
        socket.close()
        return
      }
      for (const frame of frames) dispatch(record, frame)
    })

    keepAlive(socket, { label: record.envId, logger })

    socket.on('close', () => {
      // Fail every stream this edge was part of: the alternative is a peer waiting for
      // bytes that can never arrive.
      for (const key of record.streams) {
        const route = routes.get(key)
        routes.delete(key)
        if (route === undefined) continue
        const other = connections.get(route.from === record.envId ? route.to : route.from)
        if (other === undefined) continue
        // Tell the far side the stream is over rather than leaving it half-open.
        try {
          other.socket.send(encodeFrame(FRAME.end, Buffer.from(key, 'hex')))
        } catch {
          // Its own close handler will clean up.
        }
      }
      record.streams.clear()
      if (connections.get(record.envId) === record) {
        connections.delete(record.envId)
        // Whatever this node reported is unknowable now that its link is gone. Keeping it
        // left a dead peer reported as reachable for ever, because a route to it survived
        // in the table with nothing to invalidate it.
        // The node itself, not only what it reported. It may have been learned about
        // through somebody else's table — an edge is described by its upstream as well as
        // by itself — so matching on `learnedFrom` alone left it listed as reachable with
        // nothing behind it, and this node went on repeating that upwards.
        reported.forget(record.envId)
        const dropped = reported.forgetLearnedFrom(record.envId)
        if (dropped > 0) logger.info(`federation: forgot ${dropped} node(s) reported by ${record.envId}`)
        // Everyone still connected must learn this node is gone, or they will keep
        // routing streams into a machine that can no longer answer.
        broadcastTopology()
      }
      logger.info(`federation: ${record.envId} disconnected`)
    })
    socket.on('error', (error) => {
      logger.warn(`federation: ${record.envId} tunnel error: ${error.message}`)
    })

    connections.set(record.envId, record)
    logger.info(`federation: ${record.envId} connected`)
    // The arriving edge needs the table before it can route anything, and everyone else
    // needs to know it is now online.
    broadcastTopology()
    return record
  }

  /**
   * Relay one stream between two environments.
   *
   * Frames are forwarded as they arrive, so a stream is never buffered whole — which is
   * what lets a 2 GiB file cross without the relay holding it.
   */
  function relay(fromRecord, toRecord, key, frame) {
    try {
      toRecord.socket.send(frame)
    } catch (error) {
      logger.warn(`federation: relay to ${toRecord.envId} failed: ${error.message}`)
      routes.delete(key)
    }
  }

  /** Find the envId a stream should go to, following the open frame's target. */
  function resolveTarget(record, payload) {
    const toEnvId = typeof payload?.toEnvId === 'string' ? payload.toEnvId.trim() : ''
    // `self` is a caller's shorthand for "the node I am talking to", meaningful only when
    // the caller is the origin. An intermediate node sees a real destination here, and
    // treating `self` as local there delivered every relayed stream to the middle of the
    // chain instead of its destination.
    const origin = record.envId === SELF_ENV_ID
    if (toEnvId === '') return { local: true }
    if (toEnvId === SELF_ENV_ID) {
      return origin ? { local: true } : { error: 'a relayed stream must name its destination' }
    }
    if (toEnvId === record.envId) {
      return origin ? { next: toEnvId } : { local: true }
    }
    if (connections.has(toEnvId)) return { next: toEnvId }

    // Not a direct peer: it may still be reachable through one. A node that both accepts
    // and dials is the middle of a chain, and without this it answered "unreachable" for
    // anything more than one hop away — which is every node below its own children.
    const route = reported.routeTo(toEnvId)
    if (route === undefined) {
      return { error: `environment "${toEnvId}" is unreachable` }
    }
    if (route.done === true) return { local: true }
    // `next` names the peer to hand the stream to. An empty value means a direct tunnel,
    // which the check above already covered.
    if (route.next !== '' && connections.has(route.next)) return { next: route.next }
    // No route is better than a guessed one. An earlier version picked any connected peer
    // here, "whichever reported it", and that peer was frequently the one the request had
    // just come from — so the stream ping-ponged between two nodes instead of travelling
    // to its destination. Saying so is what lets the caller report a real failure.
    return { error: `environment "${toEnvId}" is unreachable` }
  }

  /** Handle one frame from an edge. */
  function dispatch(record, frame) {
    const key = frame.id.toString('hex')
    if (frame.type !== TOPOLOGY_FRAME) {
      logger.info(`federation: ${record.envId} -> type ${frame.type} ${key.slice(0, 8)} local=${localStreams.has(key)} route=${routes.has(key)} up=${upstreamStreams.has(key)}`) 
    }

    if (frame.type === TOPOLOGY_FRAME) {
      // A child reporting what it knows. Merged into the authority's view so a node deeper
      // in a cascade is reachable and shows as online, instead of being invisible beyond
      // the first hop.
      try {
        const table = JSON.parse(frame.payload.toString('utf8'))
        // The merge changes what this node would tell others, so the next broadcast must
        // include it — but not *now*. Rebroadcasting inside the receive path closes a loop
        // across messages: each node answers the other's report with its own, for ever.
        // Measured on four nodes: 592,949 broadcasts and rising before it was stopped.
        // Flood-per-origin: every advertisement in the message is stored under the node it
        // describes, and this node's own is exempt because it knows its own links best..slice(0, 220)}`)
        let merged = false
        for (const state of Array.isArray(table?.states) ? table.states : []) {
          if (state?.envId === selfName()) continue
          if (reported.learn(state)) merged = true
        }
        for (const row of Array.isArray(table?.nodes) ? table.nodes : []) {
          if (row?.envId === selfName()) continue
          if (reported.describe(row)) merged = true
        }
        logger.info(`federation: ${record.envId} reported ${table?.nodes?.length ?? 0} node(s); ${merged ? 'merged' : 'no change'}`)
        if (merged) {
          // Marked, not broadcast here: a loop already running must go round again with
          // this change, and one that is not gets a fresh pass from the scheduler.
          advanceBroadcast('change')
          scheduleBroadcast()
          // And pass it on to this node's own upstreams. Without this a cascade only ever
          // propagates downward: the middle node merged what its child reported but told
          // nobody above it, so the root never learned the child existed — and when the
          // path through one child died, nothing knew the other child could still reach it.
          if (!notifying) {
            notifying = true
            try {
              notifyUplinks?.(record.envId)
            } finally {
              notifying = false
            }
          }
        }
      } catch (error) {
        logger.warn(`federation: ${record.envId} reported a topology this node could not read: ${error.message}`)
      }
      return
    }

    if (frame.type === FRAME.open) {
      // A stream already in flight is continued, not re-routed: resolving it again from
      // the topology would send it back the way it came, which is a ping-pong rather than
      // a relay.
      const known = flows.get(key)
      if (known !== undefined) {
        forwardFrame(known.fromRecord === record ? known.toRecord : known.fromRecord, frame)
        return
      }
      let payload
      try {
        payload = JSON.parse(frame.payload.toString('utf8'))
      } catch (error) {
        logger.warn(`federation: ${record.envId} opened a stream with invalid JSON: ${error.message}`)
        return
      }
      if (payload?.kind === 'list-environments') {
        // Retired shape, still answered: an edge built before the topology push asks for
        // the table this way, and refusing it would break a node mid-upgrade.
        void receiveListEnvironments(record, frame)
        return
      }
      if (payload?.kind === 'agent-message') {
        void receiveAgentMessage(record, frame, payload)
        return
      }
      const target = resolveTarget(record, payload)
      logger.info(`federation: open from ${record.envId} for "${payload?.toEnvId}" -> ${JSON.stringify(target)}`)
      if (target.error !== undefined) {
        sendStreamRefusal(record, frame.id, target.error)
        return
      }
      if (target.local === true) {
        // A stream aimed at this node. The admin API answers it directly.
        openLocalStream(record, key, payload)
        return
      }
      const next = connections.get(target.next)
      record.streams.add(key)
      next.streams.add(key)
      // Both ends recorded together: the whole state a relay hop needs.
      flows.set(key, { fromRecord: record, toRecord: next })
      forwardFrame(next, frame)
      return
    }

    // One table, one rule. A stream records the two ends it joins: the link the request
    // arrived on and the link it was sent out on. A frame is always destined for the end
    // it did *not* arrive on, so direction follows from the arrival rather than from a
    // guess about roles — which is what produced a loop instead of an answer.
    // A stream this node itself opened: the answer belongs to the local caller, whatever
    // route carried it. Checked before the relay table because this node's own streams are
    // in both, and the local end is the one that must receive.
    if (localStreams.has(key)) {
      receiveLocalAnswer(frame, key)
      return
    }

    const flow = flows.get(key)
    if (flow !== undefined) {
      const fromNear = flow.fromRecord === record
      const out = fromNear ? flow.toRecord : flow.fromRecord
      if (out === undefined) return
      forwardFrame(out, frame)
      // Only the answer's end releases the flow. The request's end carries the same tag
      // and arrives first; treating it as the finish dropped the flow before the answer
      // could be placed, which is what a relayed request timed out on.
      if (frame.type === FRAME.end && !fromNear) flows.delete(key)
      return
    }

    const route = routes.get(key)
    if (route === undefined) {
      // A stream we never opened: either it finished and the far side is late, or the
      // open was refused. Both are worth a name but not a crash.
      record.orphans = (record.orphans ?? 0) + 1
      if (record.orphans <= 5) {
        logger.warn(`federation: ${record.envId} frame type ${frame.type} for unknown stream ${key.slice(0, 8)}`)
      }
      return
    }
    const peer = connections.get(route.from === record.envId ? route.to : route.from)
    if (peer === undefined) {
      routes.delete(key)
      record.streams.delete(key)
      return
    }
    relay(record, peer, key, frame)
    if (frame.type === FRAME.end) {
      routes.delete(key)
      record.streams.delete(key)
      peer.streams.delete(key)
    }
  }

  /**
   * Decide what to do with a stream that arrived from an upstream.
   *
   * The agent half receives it, but only the hub knows the routing table. `forward` means
   * the destination is elsewhere in the federation and the hub should relay; otherwise the
   * agent attaches it to a local port.
   *
   * @param toEnvId - the destination named in the open frame.
   * @param owner - the link the stream arrived on.
   * @returns `{ forward: boolean, handle? }`.
   */
  function routeArrived(toEnvId, owner) {
    if (typeof toEnvId !== 'string' || toEnvId === '') return { forward: false }
    if (toEnvId === SELF_ENV_ID || toEnvId === selfName()) return { forward: false }
    const resolved = resolveTarget({ envId: selfName() }, { toEnvId })
    if (resolved.error !== undefined) return { forward: false }
    if (resolved.local === true) return { forward: false }
    const next = connections.get(resolved.next)
    logger.info(`federation: arrived "${toEnvId}" -> ${JSON.stringify(resolved)} next=${next === undefined ? 'NONE' : next.envId}`)
    if (next === undefined) return { forward: false }
    const key = () => undefined
    void key

    // Every frame of the stream is carried on, in order, with the link it came from
    // remembered so the answer goes back the same way.
    // The stream is recorded as a flow between the link it arrived on and the link it
    // leaves by. Every frame is then forwarded to the far end, and direction follows from
    // arrival — there is no second mechanism to disagree with this one.
    const handle = (frame, fromLink) => {
      const id = frame.id.toString('hex')
      if (frame.type === FRAME.open) {
        holdStream(id, fromLink, next)
      }
      const out = flows.get(id)
      if (out === undefined) return
      // `handle` only ever sees frames arriving from the upstream, so the answer always
      // goes the other way. Comparing identities here was wrong: the arrival end is a
      // wrapper, not the link object, so the comparison never matched and every frame was
      // sent back the way it came — the ping-pong that made a relayed request answer with
      // its own bytes.
      forwardFrame(out.toRecord, frame)
      // Deliberately *not* removed on `end`. For HTTP the request's end arrives long
      // before the answer does, and dropping the flow there left every relaying node
      // unable to place the response — it reported frames "for unknown stream" while the
      // caller timed out. The flow is released when the answer's own end passes through
      // `dispatch`, which is the point where neither side can say anything more.
    }
    return { forward: true, handle }
  }

  /**
   * Send one frame to a connection, re-encoded.
   *
   * The frame arrives decoded — the reader hands back `{ type, id, payload }` — so it has
   * to be encoded again for the next hop. Sending the object itself fails inside `ws`
   * with a type error, which is what a first version did.
   */
  function relayToLink(record, frame) {
    try {
      record.socket.send(encodeFrame(frame.type, frame.id, frame.payload))
    } catch (error) {
      logger.warn(`federation: could not forward a frame to ${record.envId}: ${error.message}`)
    }
  }

  /** Refuse a stream at open time; the sender reads the reason from a zero-length end. */
  function sendStreamRefusal(record, id, reason) {
    logger.warn(`federation: refusing a stream from ${record.envId}: ${reason}`)
    try {
      record.socket.send(encodeFrame(FRAME.end, id))
    } catch {
      // The close handler cleans up.
    }
  }

  /** Streams this node answered itself, by streamId(hex) → handlers. */
  const localStreams = new Map()

  /**
   * Answer a stream addressed to this node.
   *
   * The gateway supplies `openLocalStream` through `handleLocalStream`; without it, a
   * stream aimed here is refused rather than silently dropped.
   */
  function openLocalStream(record, key, payload) {
    if (handleLocalStream === undefined) {
      sendStreamRefusal(record, Buffer.from(key, 'hex'), 'this node does not answer streams')
      return
    }
    localStreams.set(key, {
      from: record.envId,
      send(frame) {
        record.socket.send(frame)
      },
    })
    record.streams.add(key)
    handleLocalStream(payload, {
      write(piece) {
        try {
          record.socket.send(encodeFrame(FRAME.data, Buffer.from(key, 'hex'), piece))
        } catch {
          localStreams.delete(key)
        }
      },
      end() {
        localStreams.delete(key)
        record.streams.delete(key)
        try {
          record.socket.send(encodeFrame(FRAME.end, Buffer.from(key, 'hex')))
        } catch {
          // Already gone.
        }
      },
    })
  }

  /** Supplied by the gateway: how this node answers a stream aimed at itself. */
  let handleLocalStream

  /**
   * Supplied by the gateway: tell this node's own upstreams what it now knows.
   *
   * A node can be a parent and a child at once. When a child reports something new the
   * result has to travel on to this node's own parents — otherwise a cascade only ever
   * propagates downward and the root of a chain never learns about its tail.
   */
  let notifyUplinks

  /**
   * Set while a report is being passed uphill.
   *
   * A report that arrives while another is being forwarded is dropped: the two would
   * otherwise answer each other for ever, which is what a broadcast storm looked like when
   * this was first written.
   */
  let notifying = false

  /** The retired request-shaped list-environments call. */
  async function receiveListEnvironments(record, frame) {
    const table = listEnvironments === undefined ? [] : listEnvironments()
    try {
      record.socket.send(encodeJsonFrame(FRAME.data, frame.id, { ok: true, environments: table }))
      record.socket.send(encodeFrame(FRAME.end, frame.id))
    } catch (error) {
      logger.warn(`federation: could not answer ${record.envId}: ${error.message}`)
    }
  }

  /**
   * Deliver one agent message that arrived from an edge.
   *
   * The sender's identity comes from the connection, never from the payload, so a frame
   * cannot claim to come from another environment.
   */
  async function receiveAgentMessage(record, frame, payload) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : ''
    const text = typeof payload.text === 'string' ? payload.text : ''
    const toEnvId = typeof payload.toEnvId === 'string' ? payload.toEnvId.trim() : ''
    if (sessionId === '' || text === '') {
      sendStreamRefusal(record, frame.id, 'an agent message needs sessionId and text')
      return
    }
    let answer
    if (toEnvId === '' || toEnvId === SELF_ENV_ID || toEnvId === record.envId) {
      answer = await deliver({ fromEnvId: record.envId, sessionId, text })
    } else if (forward !== undefined) {
      answer = await forward(toEnvId, { fromEnvId: record.envId, sessionId, text })
    } else {
      answer = { ok: false, error: 'this node forwards nothing' }
    }
    try {
      record.socket.send(encodeJsonFrame(FRAME.data, frame.id, answer))
      record.socket.send(encodeFrame(FRAME.end, frame.id))
    } catch (error) {
      logger.warn(`federation: could not answer ${record.envId}: ${error.message}`)
    }
  }

  /**
   * Open a stream toward one environment.
   *
   * The caller writes bytes and closes; routing, framing and delivery are this module's
   * problem. `sink` receives the answer's bytes as they arrive.
   *
   * @param toEnvId - destination environment.
   * @param options.port - unused on this side; kept for symmetry with the leaf.
   * @param options.sink - `(piece) => void`, called for each answer piece.
   * @param options.onEnd - called when the far end closed the stream.
   * @param options.timeoutMs - how long to wait for the first byte.
   * @returns `{ ok: true, send, end }` or `{ ok: false, error }`.
   */
  function openStream(toEnvId, { sink, onEnd, onError, target, timeoutMs = 300_000 } = {}) {
    // The direct peer, or whoever this node can reach the destination through.
    const resolved = resolveTarget({ envId: selfName() }, { toEnvId })
    logger.info(`federation: openStream to "${toEnvId}" resolved ${JSON.stringify(resolved)}`)
    if (resolved.error !== undefined) {
      return { ok: false, error: resolved.error }
    }
    const nextId = resolved.local === true ? toEnvId : resolved.next
    if (!connections.has(nextId)) {
      return { ok: false, error: `environment "${toEnvId}" is unreachable` }
    }
    const record = connections.get(nextId)
    const id = newRequestId()
    const key = id.toString('hex')
    record.streams.add(key)
    // The near end of this stream is this process, not a socket: it has a `send` so the
    // flow loop can treat both ends the same way.
    // `forwardFrame` sends bytes; for the local end those bytes are handed straight to
    // the answering callback, so both ends speak the same interface without a decode step.
    const local = {
      envId: selfName(),
      socket: { send: (bytes) => receiveLocalAnswerBytes(bytes, key) },
    }
    flows.set(key, { fromRecord: local, toRecord: record })
    localStreams.set(key, {
      from: SELF_ENV_ID,
      onData: sink,
      onEnd,
      onError,
      timer: setTimeout(() => {
        localStreams.delete(key)
        flows.delete(key)
        onError?.(`environment "${toEnvId}" did not answer in time`)
      }, timeoutMs),
    })
    // Tell the far side where to attach: a port names a local listener there, and its
    // absence means that node's daemon.
    // The frame names the *destination*, not the next hop: an intermediate node resolves
    // its own next hop from the same field, so a chain relays without extra state.
    record.socket.send(encodeJsonFrame(FRAME.open, id, target === undefined ? { toEnvId } : { toEnvId, target }))
    return {
      ok: true,
      id,
      send(piece) {
        if (record.socket.readyState !== 1) return
        record.socket.send(encodeFrame(FRAME.data, id, piece))
      },
      end() {
        record.socket.send(encodeFrame(FRAME.end, id))
      },
    }
  }

  /** Answer a data/end frame for a stream this node opened itself. */
  function receiveLocalAnswer(frame, key) {
    const entry = localStreams.get(key)
    logger.info(`federation: local answer ${key.slice(0, 8)} type ${frame.type}: ${entry === undefined ? 'no local stream' : 'delivered'}`)
    if (entry === undefined) return
    if (frame.type === FRAME.data) {
      entry.onData?.(frame.payload)
      return
    }
    if (frame.type === FRAME.end) {
      clearTimeout(entry.timer)
      localStreams.delete(key)
      localReaders.delete(key)
      routes.delete(key)
      entry.onEnd?.()
    }
  }

  /**
   * The loopback authority a peer's own UI answers on, as `host:port`.
   *
   * Learned from the peer's report, because a port number cannot be derived and no other
   * side knows it. Empty when the peer has not said.
   *
   * @param envId - the environment.
   * @returns `127.0.0.1:<port>`, or an empty string when unknown.
   */
  function harnessAuthorityOf(envId) {
    // A direct peer declares this at handshake; one further out is described by a report.
    // Only the node itself knows the port, and a wrong guess signs a cookie the browser
    // will never accept.
    const declared = connections.get(envId)?.claimedHarnessPort
    if (Number.isInteger(declared) && declared > 0) return `127.0.0.1:${declared}`
    const port = Number(reported.get(envId)?.harnessPort)
    return Number.isInteger(port) && port > 0 ? `127.0.0.1:${port}` : ''
  }

  /** Whether the hub has a live tunnel to this environment. */
  function isOnline(envId) {
    return connections.has(envId)
  }

  /**
   * Whether this environment is reachable at all, including through a child.
   *
   * `isOnline` answers only for a direct tunnel, which is the wrong question in a cascade:
   * a node two hops down has no tunnel here, yet a route exists. Reporting it offline is
   * what made the panel show a live node as dead.
   */
  function isReachable(envId) {

    if (connections.has(envId)) return true
    // A route is the honest test: if this node can put a stream on the way to `envId`, it
    // is reachable, whatever a peer's report said about its `online` flag. Deciding from
    // the flag alone made the panel show a node as offline while calls to it succeeded —
    // the two answered different questions from the same table.
    const route = reported.routeTo(envId)
    if (route === undefined) {
      logger.info(`federation: no route to "${envId}"; nodes=${reported.nodes().map((r) => r.envId).join(',')} adj=${reported.advertisements().map((s) => `${s.envId}:[${s.neighbours.join(' ')}]`).join(' ')}`)
    }
    return route !== undefined
  }

  /** Every node reachable here, merged from direct tunnels and child reports. */
  function knownNodes() {
    return reported.nodes()
  }

  /** Every environment id with a live tunnel. */
  function ids() {
    return [...connections.keys()]
  }

  /** The environments this hub can reach, for a tool that lists them. */
  function listKnownEnvironments() {
    return listEnvironments === undefined ? [] : listEnvironments()
  }

  /** The record for one environment, or undefined. */
  function recordOf(envId) {
    return connections.get(envId)
  }

  /** Close every tunnel. */
  function close() {
    for (const [, record] of connections) {
      try {
        // `terminate` rather than `close`: a close is a handshake that waits for the peer
        // to answer, and a peer that has already gone (or is wedged) leaves the socket —
        // and the process — alive. Shutdown must not depend on the other end cooperating.
        record.socket.terminate()
        // `terminate` closes the WebSocket layer; the TCP socket underneath it is only
        // released once it is destroyed too. Without this the process keeps running with
        // a socket nobody is listening on.
        record.socket._socket?.destroy()
      } catch {
        // Already gone.
      }
    }
    connections.clear()
    routes.clear()
    localStreams.clear()
  }

  /** Resolve a token to its environment. */
  function verify(token) {
    return verifyToken(token)
  }

  return {
    /** Attach one authenticated edge socket. */
    accept(environment, socket, claim) {
      return register(environment, socket, claim)
    },
    /**
     * The id a connected node declared for itself, given what the registry calls it.
     *
     * Routing only knows the declared id, so a caller holding a registry record has to
     * translate before asking whether that node is reachable.
     */
    declaredIdFor,
    /** How this node answers a stream aimed at itself; set once at mount. */
    setLocalStreamHandler(handler) {
      handleLocalStream = handler
    },
    /** How this node tells its own upstreams what it knows; set once at mount. */
    setUplinkNotifier(handler) {
      notifyUplinks = handler
    },
    /** Whether a stream that arrived here is for this node or beyond it. */
    routeArrived,
    /** Everything this node has heard, children included. */
    ownView: reported,
    /** Called by `dispatch` for a data/end frame on a stream this node opened. */
    receiveLocalAnswer,
    /**
     * Deliver one agent message as if it had arrived from `fromEnvId`.
     *
     * Exposed for tests that drive the path from the receiving side; the production
     * caller is `receiveAgentMessage`, which takes the sender from the connection.
     */
    deliverForTest(fromEnvId, body) {
      return deliver({ fromEnvId, sessionId: body.sessionId, text: body.text })
    },
    openStream,
    isOnline,
    isReachable,
    harnessAuthorityOf,
    knownNodes,
    ids,
    listKnownEnvironments,
    recordOf,
    broadcastTopology,
    verify,
    close,
  }
}

/**
 * The token an incoming edge presents.
 *
 * Accepted from the query string, because a browser cannot set headers on a WebSocket
 * upgrade, and from a bearer header for a non-browser client that can.
 *
 * @param req - the upgrade request.
 * @returns the token, or an empty string when none was presented.
 */
export function tokenOf(req) {
  const url = req.url ?? ''
  const queryAt = url.indexOf('?')
  if (queryAt !== -1) {
    const token = new URLSearchParams(url.slice(queryAt + 1)).get('token')
    if (token !== null && token !== '') return token
  }
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length)
  return ''
}

/** The server an edge connects to; a thin wrapper so the entry file stays readable. */
export function createTunnelServer() {
  return new WebSocketServer({ noServer: true })
}
