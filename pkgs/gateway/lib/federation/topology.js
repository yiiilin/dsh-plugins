/**
 * The federation's shape, and who knows it.
 *
 * A node cannot route to an environment it has never heard of. Before this module each
 * edge learned the environment table by *asking* the main node whenever it needed it —
 * which worked, but left every node that had not asked yet blind, and made "is this peer
 * online" unanswerable locally. That gap produced a real bug: an edge asked its own
 * tunnel table whether a peer was up, which is always empty on an edge, so every
 * edge-to-edge message reported "offline".
 *
 * The main node is the authority — it is the only node holding every tunnel — and it
 * pushes the whole picture to every connected edge. Pushed, not polled: a topology that
 * changes and is not broadcast leaves nodes routing into a machine that is gone.
 *
 * Two parts, because they change for different reasons:
 *
 * - **nodes** — what each environment *is*: label, hostname, kind, whether it is online,
 *   when it was last seen. Metadata outlives any particular connection.
 * - **edges** — how to *reach* it from here: which peer to hand a stream to, and whether
 *   a direct tunnel exists. Today every edge hangs off the main node, so a route is one
 *   hop; the field exists so that a tree — or a mesh with intermediate hops — does not
 *   need a new message shape.
 *
 * @module @yiln-dsh/dsh-gateway/federation/topology
 */

/** Frame tag carrying one topology snapshot. Not a stream: it has no data/end. */
export const TOPOLOGY_FRAME = 4

/**
 * One node's metadata, as every node in the federation sees it.
 *
 * @param environment - the registry record, or `{ id: 'self' }` for this machine.
 * @param options.online - whether it is currently reachable.
 * @param options.selfId - this node's own id, so the self row is marked.
 * @returns the flat row that goes on the wire.
 */
export function nodeRow(environment, { online = false, selfId = '' } = {}) {
  // The row is already in wire shape when it comes from `listNodes` (`envId`), and in
  // registry shape when it comes from a stored record (`id`). Accept both: reading only
  // `id` produced rows whose `envId` was null, which silently broke routing — a node
  // without an id cannot be a route destination.
  const envId = environment.envId ?? environment.id
  return {
    envId,
    label: environment.label ?? envId,
    // `kind` is absent for this node's own row: it is not a registry record.
    kind: environment.kind ?? 'self',
    hostname: environment.hostname ?? '',
    online: envId === selfId ? true : online === true,
    // A peer needs this to address the mux socket, and cannot derive it.
    harnessPort: Number(environment.harnessPort) || 0,
    lastSeen: typeof environment.lastSeen === 'number' ? environment.lastSeen : 0,
  }
}

/**
 * How to reach one environment from the node holding this table.
 *
 * `via` is the peer a stream must be handed to; empty means the target is directly
 * reachable (it is this node, or a tunnel to it exists here). `hops` counts the forwards,
 * so a caller can tell "reachable directly" from "reachable through one intermediate".
 *
 * @param envId - the destination.
 * @param options.via - the next peer, or empty for a direct destination.
 * @param options.hops - how many forwards the route needs, 0 for direct.
 * @returns the edge row.
 */
export function edgeRow(envId, { via = '', hops = 0 } = {}) {
  return { to: envId, via, hops }
}

/**
 * Build one snapshot.
 *
 * `seq` is monotonic per sender so a receiver can tell a late broadcast from a current
 * one. Without it, a snapshot that arrives out of order would resurrect a node that has
 * already gone offline — the failure mode is a stale "online" that routes into nothing.
 *
 * @param options.nodes - node rows.
 * @param options.edges - edge rows.
 * @param options.seq - this sender's counter.
 * @param options.at - epoch milliseconds the snapshot was built.
 * @returns the snapshot to broadcast.
 */
export function snapshot({ nodes, edges, seq, at = Date.now() }) {
  return { seq, at, nodes, edges }
}

/**
 * Decide whether a received snapshot should replace the one held.
 *
 * @param held - the current snapshot, or undefined.
 * @param incoming - the snapshot just received.
 * @returns whether `incoming` is newer and should be adopted.
 */
export function isNewer(held, incoming) {
  if (incoming === undefined || incoming === null) return false
  if (!Array.isArray(incoming.nodes) || !Array.isArray(incoming.edges)) return false
  if (held === undefined) return true
  // Strictly greater: the same seq seen twice is a duplicate, and adopting it again does
  // nothing useful while making the "changed" signal fire twice.
  return Number(incoming.seq) > Number(held.seq)
}

/**
 * A local view of the federation, fed by broadcasts.
 *
 * Deliberately a plain object with no timers: freshness is the sender's job (it
 * broadcasts on every change), and a node that invents its own expiry would disagree
 * with the authority about who is online.
 *
 * @param options.selfId - this node's id.
 * @returns `{ apply, nodes, edges, routeTo, get }`.
 */
export function createTopologyView({ selfId = '' } = {}) {
  /**
   * What this node knows about the federation, by environment id.
   *
   * A map rather than one snapshot because two paths can describe the same node, and
   * "which is right" has an answer — the shorter path, in hops. Keeping the last snapshot
   * whole made the answer depend on message arrival order.
   */
  const known = new Map()

  /** The highest `seq` seen from each source, so one sender's late message is dropped. */
  const highWater = new Map()

  /** Every edge, so a route can name the next hop. */
  const edgeRoutes = new Map()

  let me = selfId

  /** This node's own counter for the tables it sends. */
  let outboundSeq = 0

  /** Fold one snapshot in. @returns whether anything changed. */
  function absorb(incoming, source) {
    const fromHops = Number(incoming.hops ?? 0)
    let changed = false
    const rows = Array.isArray(incoming.nodes) ? incoming.nodes : []
    for (const row of rows) {
      const envId = row.envId
      if (typeof envId !== 'string' || envId === '') continue
      const hops = envId === me ? 0 : fromHops + 1
      const held = known.get(envId)
      // Shorter is truer: a node one hop away must not become three because a longer path
      // reported it later. At equal distance the newest report wins, because two peers one
      // hop away are equally authoritative and the later one has more recent information —
      // keeping the incumbent made a node that only the second peer knew about stay
      // invisible for ever.
      if (held !== undefined && held.hops < hops) continue
      known.set(envId, { ...row, hops })
      changed = true
    }
    for (const row of incoming.edges ?? []) {
      if (typeof row.to !== 'string' || row.to === '') continue
      const hops = Number(row.hops ?? fromHops) + 1
      const held = edgeRoutes.get(row.to)
      if (held !== undefined && held.hops <= hops) continue
      // Two ways a route arrives, and they answer different questions.
      //
      // - Built locally, a row names its own `via`: the operator states the next hop.
      // - Reported by a peer, the row's `via` describes *that* node's next hop and is
      //   meaningless here; what matters is which of this node's links the report came on.
      //
      // Getting this backwards sent relayed streams to the wrong peer, so the distinction
      // is explicit rather than a null-coalescing chain.
      const via = incoming.from === undefined || incoming.from === '' ? (row.via ?? '') : (source ?? '')
      edgeRoutes.set(row.to, { to: row.to, via, hops })
      changed = true
    }
    // This node is always reachable from itself, whatever anyone else says.
    if (me !== '' && !known.has(me)) {
      known.set(me, { envId: me, label: me, kind: 'self', online: true, lastSeen: 0, hops: 0 })
      changed = true
    }
    return changed
  }

  return {
    /** Learn which environment this node is. */
    setSelfId(envId) {
      me = envId
      known.set(envId, { envId, label: envId, kind: 'self', online: true, lastSeen: 0, hops: 0 })
    },

    /**
     * Fold a snapshot in.
     *
     * `seq` orders one sender's broadcasts, compared per source: two upstreams each count
     * from one, and comparing across them discarded whichever was behind.
     */
    apply(incoming, { source } = {}) {
      if (incoming === undefined || incoming === null) return false
      if (!Array.isArray(incoming.nodes)) return false
      const from = typeof incoming.from === 'string' && incoming.from !== '' ? incoming.from : (source ?? '')
      const seq = Number(incoming.seq)
      const seen = highWater.get(from)
      // A sender's counter restarts at one when it restarts, so a lower `seq` from a known
      // source is not necessarily stale — it is usually a fresh process. Treating it as
      // stale discarded every table until the new process happened to overtake the old
      // high-water mark, which for a quiet federation could be never: the peer stayed
      // invisible with its last pre-restart view. Adopt it and reset the mark.
      if (seen !== undefined && seq === seen) return false
      if (seen !== undefined && seq < seen) {
        highWater.set(from, seq)
        absorb(incoming, from)
        return true
      }
      highWater.set(from, seq)
      // A newer table from a known source is news even when it adds no row: the source is
      // still reporting, and a caller uses the return value to decide whether to log.
      absorb(incoming, from)
      return true
    },

    /** Every node row this node knows, itself included. */
    nodes() {
      return [...known.values()]
    },

    /** Every edge, as `{ to, via, hops }`. */
    edges() {
      return [...edgeRoutes.values()]
    },

    /** The row for one environment, or undefined. */
    get(envId) {
      return known.get(envId)
    },

    /** What to hand to a stream addressed to `envId`. */
    routeTo(envId) {
      if (envId === '' || envId === me) return { done: true }
      const route = edgeRoutes.get(envId)
      if (route === undefined) {
        if (known.has(envId)) return { done: false, next: '' }
        return undefined
      }
      return { done: false, next: route.via }
    },

    /**
     * What to send uphill: this node's view, minus what came from the receiving side.
     *
     * Split-horizon. Echoing back what a peer just told us is what would make a loop
     * circulate forever; withholding it terminates propagation without a hop limit.
     */
    outbound({ exclude } = {}) {
      const nodes = [...known.values()]
        .filter((row) => row.envId !== exclude)
        .map(({ hops, ...row }) => row)
      if (nodes.length === 0) return undefined
      // `via` is rewritten to the neighbour the *receiver* should hand the stream to, so
      // a node one hop further out can build a route from a table it did not observe.
      // Blanking it here left every receiver unable to answer "which peer do I use for
      // that destination", which is why a cascade could be described but not routed.
      // Only the receiving node itself is withheld. Filtering by `via` as well dropped
      // every route this node had learned *through* that peer, which is most of them — the
      // report shrank to the two rows that happened to survive, so the node at the top of
      // a cascade never saw its tail.
      const edges = [...edgeRoutes.values()]
        .filter((row) => row.to !== exclude)
        .map((row) => ({ to: row.to, via: '', hops: row.hops }))
      return { seq: outboundSeq += 1, from: me, nodes, edges }
    },

    /** The raw snapshot, for diagnostics. */
    get snapshot() {
      return { nodes: this.nodes(), edges: this.edges() }
    },
  }
}
