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
import { createTopologyView, edgeRow, nodeRow, snapshot, TOPOLOGY_FRAME } from './topology.js'

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
export function createTunnelHub({ verifyToken, logger, deliver, forward, listEnvironments, listNodes }) {
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
  const reported = createTopologyView({})

  /** Monotonic per sender, so a receiver can discard a late snapshot. */
  let topologySeq = 0

  /** Set while a broadcast loop is running, so a re-entrant call cannot interleave. */
  let broadcasting = false

  /** Set when the table changed during a broadcast, so the loop repeats with it. */
  let topologyDirty = false

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
    const rows = listNodes === undefined ? [] : listNodes()
    return rows.find((row) => row.kind === 'self')?.envId ?? SELF_ENV_ID
  }

  function buildSnapshot() {
    if (listNodes === undefined) return undefined
    const nodes = listNodes().map((row) => {
      // A node's own name beats whatever the registry was given when it was enrolled:
      // the machine is the authority on what it is called, and two upstreams that typed
      // different labels would otherwise disagree about the same machine.
      const claimed = connections.get(row.envId)?.claimedName
      const label = typeof claimed === 'string' && claimed !== '' ? claimed : row.label
      return nodeRow({ ...row, label }, { online: row.online, selfId: row.envId })
    })
    // Every environment this node can reach directly is one hop away, so `via` is empty.
    // The field is carried anyway so a tree does not need a different message shape.
    const edges = nodes
      .filter((row) => row.kind !== 'self')
      .map((row) => edgeRow(row.envId))

    // Add what the children reported but this node cannot see directly. Without this the
    // authority believes its own links are the whole federation, so a node deeper in a
    // cascade is reported as absent — it shows offline and no route to it exists.
    const seen = new Set(nodes.map((row) => row.envId))
    for (const row of reported.nodes()) {
      if (seen.has(row.envId)) continue
      seen.add(row.envId)
      // Already in wire shape: reported by a peer that filled it in. Re-deriving it here
      // recomputed `online` against *this* node's id, so a live node came out offline
      // whenever it was not this node — which is every node the cascade is meant to show.
      nodes.push({
        envId: row.envId,
        label: row.label ?? row.envId,
        kind: row.kind ?? 'remote',
        hostname: row.hostname ?? '',
        online: row.online !== false,
        lastSeen: typeof row.lastSeen === 'number' ? row.lastSeen : 0,
        harnessPort: Number(row.harnessPort) || 0,
      })
      edges.push(edgeRow(row.envId, { hops: row.hops ?? 1 }))
    }
    // No seq here: it belongs to the message about to be sent, not to the act of reading
    // the table. Incrementing while building let a re-entrant broadcast hand out two
    // sequences for one state, and a failed send burn one.
    return { nodes, edges }
  }

  /**
   * Push the current shape to every connected edge.
   *
   * Called on every change — an edge arriving or leaving, and an environment being added,
   * enabled or removed. A topology that changes without this leaves peers routing into a
   * machine that is gone.
   *
   * @returns how many edges were told.
   */
  /** The table as it was last sent, so an unchanged table is not broadcast again. */
  let lastSent = ''

  /**
   * Broadcast, but only when the table changed.
   *
   * The loop guard belongs here rather than in a caller. Two nodes that each report to the
   * other will answer every report with one of their own; without a "nothing changed"
   * check the conversation never ends, and each round carries a higher sequence number so
   * the receiver treats it as news. Comparing the serialized table terminates it: once the
   * merges settle, both sides produce the same thing.
   */
  function broadcastTopology(force = false) {
    // One snapshot per burst, and one sequence number for it.
    //
    // A send can synchronously trigger a `close` on another socket, which calls back into
    // this function. Without coalescing, the inner call would build from the newer table
    // and take the higher sequence, then the outer loop would finish the older snapshot
    // under a lower one — peers would hold a stale table believing it current. So a
    // re-entrant call only marks the burst dirty; the outer call goes round again with
    // the newest table under one new sequence.
    if (broadcasting) {
      topologyDirty = true
      return 0
    }
    broadcasting = true
    let sent = 0
    try {
      do {
        topologyDirty = false
        const table = buildSnapshot()
        if (table === undefined) break
        const serialized = JSON.stringify(table)
        if (force !== true && serialized === lastSent) break
        lastSent = serialized
        topologySeq += 1
        const seq = topologySeq
        for (const [, record] of connections) {
          try {
            // Each edge is told which environment it *is*: a leaf knows only its token,
            // and without its own id it cannot tell "the destination is me" from "a peer".
            record.socket.send(encodeJsonFrame(TOPOLOGY_FRAME, Buffer.alloc(16), { ...table, seq, from: selfName(), selfEnvId: record.envId }))
            sent += 1
          } catch (error) {
            logger.warn(`federation: could not send the topology to ${record.envId}: ${error.message}`)
          }
        }
      } while (topologyDirty)
    } finally {
      broadcasting = false
    }
    return sent
  }

  /** Broadcast after the current turn, so a report is not answered inside its own handler. */
  let scheduled
  function scheduleBroadcast() {
    if (scheduled !== undefined) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      if (topologyDirty) broadcastTopology()
    }, 50)
    scheduled.unref?.()
  }

  /**
   * Register one edge socket.
   *
   * @returns the connection record, or undefined when the token was rejected.
   */
  function register(environment, socket, claim = {}) {
    const record = {
      envId: environment.id,
      socket,
      reader: new FrameReader(),
      /** The name this node declared for itself, if it sent one. */
      claimedName: typeof claim.name === 'string' ? claim.name : '',
      claimedHostname: typeof claim.hostname === 'string' ? claim.hostname : '',
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
        const merged = reported.apply(table, { source: record.envId })
        logger.info(`federation: ${record.envId} reported ${table?.nodes?.length ?? 0} node(s); ${merged ? 'merged' : 'no change'}`)
        if (merged) {
          topologyDirty = true
          scheduleBroadcast()
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
      const out = flow.fromRecord === record ? flow.toRecord : flow.fromRecord
      if (out === undefined) return
      forwardFrame(out, frame)
      if (frame.type === FRAME.end) flows.delete(key)
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
      if (frame.type === FRAME.end) flows.delete(id)
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
    const row = reported.get(envId)
    const port = Number(row?.harnessPort)
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
      logger.info(`federation: no route to "${envId}"; nodes=${reported.nodes().map((r) => r.envId).join(',')} edges=${reported.edges().map((r) => r.to + '<-' + r.via).join(',')}`)
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
