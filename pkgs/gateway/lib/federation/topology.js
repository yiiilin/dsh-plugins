/**
 * The federation's shape: who exists, and who is connected to whom.
 *
 * This is a link-state table, not a routing table. Every node keeps the same facts — each
 * environment's metadata plus the set of *neighbours* it is directly connected to — and
 * works out its own next hop locally. The distinction matters:
 *
 * The previous design broadcast a computed answer (`to: 'n4', via: 'n3', hops: 2`) and
 * every node repeated whatever it was told. That answer goes stale the moment a link dies,
 * and nothing can recompute it, because the fact it was derived from — who is actually
 * connected to whom — was never sent. The symptoms were ones no amount of patching cured:
 * a node stayed "reachable" with a route through a dead peer, a second path was never
 * discovered after the first one failed, and a restart reset the hop count that the choice
 * depended on.
 *
 * Here the answer is derived, so it cannot be stale: a dead link disappears from the
 * neighbour set, the graph no longer contains a path, and the next hop changes with no
 * special case. Reaching a node through two different upstreams, a cycle, or a node whose
 * only path goes three hops up and two across all fall out of one shortest-path walk.
 *
 * The model is deliberately the same shape as EasyTier's OSPF routing — link-state
 * advertisements carrying adjacency, with each peer computing its own table — because that
 * pairing is what makes a mesh work, not the particular algorithm.
 *
 * @module @yiln-dsh/dsh-gateway/federation/topology
 */

/** Frame tag carrying one topology snapshot. Not a stream: it has no data/end. */
export const TOPOLOGY_FRAME = 4

/**
 * One environment's metadata, as every node in the federation sees it.
 *
 * @param environment - the registry record, or a locally built row.
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
    hostname: environment.hostname ?? '',
    online: envId === selfId ? true : online === true,
    // A peer needs this to address the mux socket, and cannot derive it.
    harnessPort: Number(environment.harnessPort) || 0,
    lastSeen: typeof environment.lastSeen === 'number' ? environment.lastSeen : 0,
  }
}

/**
 * One node's view of itself in the link-state table.
 *
 * `neighbours` is what this node is *directly* connected to — the fact routing is derived
 * from. It is the only thing a node can report about itself that no one else can, which is
 * why it travels while routes do not.
 *
 * @param envId - the reporting node.
 * @param neighbours - ids it has a live direct link to, in either direction.
 * @param seq - this node's own counter; a receiver keeps the higher one.
 * @returns the advertisement.
 */
export function linkState(envId, neighbours, seq) {
  const list = [...new Set((neighbours ?? []).filter((one) => typeof one === 'string' && one !== ''))]
  list.sort()
  return { envId, neighbours: list, seq: Number(seq) || 0 }
}

/**
 * A table that knows every node and every adjacency in the federation.
 *
 * Each node holds one, keeps the newest advertisement per *origin* (link-state routing is
 * flood-per-origin, not last-writer-wins), and derives routes from the merged graph.
 *
 * @param options.selfId - this node's own id.
 * @returns the view.
 */
export function createTopologyView({ selfId = '' } = {}) {
  let me = selfId

  /**
   * This node's own advertisement counter, owned by the view.
   *
   * It must be the *same* counter wherever this node speaks from: the hub broadcasts and
   * the agent announces, and two counters meant one node's advertisement arrived with
   * numbers that did not order — a receiver kept whichever came last, so an empty neighbour
   * list sent during startup overwrote the real one indefinitely.
   */
  let ownSeq = 0

  /** Newest advertisement per origin: `envId -> { envId, neighbours, seq }`. */
  const advertisements = new Map()

  /** Metadata per environment, from whichever report described it most recently. */
  const described = new Map()

  /**
   * Rebuild the graph from the advertisements.
   *
   * Edges are undirected because a tunnel works both ways once established: an edge that
   * dials its upstream still answers streams on that same socket, which is how a stream
   * reaches a leaf at all.
   */
  function graph() {
    const adjacency = new Map()
    const link = (a, b) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set())
      adjacency.get(a).add(b)
    }
    for (const state of advertisements.values()) {
      if (!adjacency.has(state.envId)) adjacency.set(state.envId, new Set())
      for (const peer of state.neighbours) {
        link(state.envId, peer)
        // The far side may not have advertised yet; it still exists as a vertex.
        if (!adjacency.has(peer)) adjacency.set(peer, new Set())
      }
    }
    if (me !== '') {
      if (!adjacency.has(me)) adjacency.set(me, new Set())
      // This node's own advertisement is half of every path that starts here. The loop
      // below only picks up links a *peer* reported; without this line the origin has no
      // edges, so a direct neighbour resolves and anything one hop further is unreachable
      // while sitting in the table.
      const own = advertisements.get(me)
      if (own !== undefined) for (const peer of own.neighbours) link(me, peer)
      for (const state of advertisements.values()) {
        if (state.neighbours.includes(me)) link(me, state.envId)
      }
    }
    return adjacency
  }

  /**
   * The next hop towards `target`, by breadth-first search.
   *
   * Breadth-first is enough because every link costs the same; EasyTier's Dijkstra buys
   * latency-weighted paths, which this federation has no measurement for.
   *
   * @param target - destination environment id.
   * @returns the neighbour to hand the stream to, or `undefined` when no path exists.
   */
  function nextHop(target) {
    if (target === me) return undefined
    const adjacency = graph()
    if (!adjacency.has(target)) return undefined
    const start = adjacency.get(me)
    if (start === undefined) return undefined
    if (start.has(target)) return target

    // Breadth-first from this node, remembering the first step taken to each vertex. The
    // first step *is* the answer: it names the neighbour to hand the stream to.
    const seen = new Set([me])
    let frontier = []
    for (const peer of start) {
      if (seen.has(peer)) continue
      seen.add(peer)
      frontier.push({ node: peer, first: peer })
    }
    while (frontier.length > 0) {
      const next = []
      for (const entry of frontier) {
        if (entry.node === target) return entry.first
        for (const peer of adjacency.get(entry.node) ?? []) {
          if (seen.has(peer)) continue
          seen.add(peer)
          next.push({ node: peer, first: entry.first })
        }
      }
      frontier = next
    }
    return undefined
  }

  return {
    /** This node's own id, as the table knows it. */
    get selfId() {
      return me
    },

    /** Replace this node's own identity, learned from an upstream's advertisement. */
    setSelfId(envId) {
      if (typeof envId === 'string' && envId !== '') me = envId
    },

    /**
     * Record one advertisement.
     *
     * Per-origin ordering, not global: two upstreams count independently, and comparing
     * their counters made one of them look permanently stale.
     *
     * @param state - `{ envId, neighbours, seq }`.
     * @returns whether anything changed.
     */
    learn(state) {
      if (state === null || typeof state !== 'object') return false
      const origin = String(state.envId ?? '')
      if (origin === '') return false
      const next = linkState(origin, state.neighbours, state.seq)
      const held = advertisements.get(origin)
      // Newer wins, older is a duplicate. Accepting anything that merely differed let a
      // stale copy overtake a fresh one — two paths carried the same node's advertisement
      // with different counters, and the older one kept overwriting the newer, so a node
      // oscillated between its real neighbour list and an empty one.
      if (held !== undefined && next.seq <= held.seq) return false
      advertisements.set(origin, next)
      return true
    },

    /** Record metadata for one environment. */
    describe(row) {
      if (row === null || typeof row !== 'object') return false
      const envId = String(row.envId ?? '')
      if (envId === '') return false
      const before = described.get(envId)
      const fresh = nodeRow({ ...(before ?? {}), ...row, envId }, { online: row.online === true })
      described.set(envId, fresh)
      return before === undefined
    },

    /** Everything this node knows, as advertisements — what to flood onwards. */
    advertisements() {
      return [...advertisements.values()]
    },

    /** Metadata for every environment, this node included. */
    nodes() {
      const rows = [...described.values()]
      if (me !== '' && !described.has(me)) {
        rows.push({ envId: me, label: me, hostname: '', online: true, harnessPort: 0, lastSeen: 0 })
      }
      return rows
    },

    /** The row for one environment, or undefined. */
    get(envId) {
      return described.get(envId)
    },

    /** Whether this node can currently reach `envId`. */
    reaches(envId) {
      if (envId === me) return true
      return nextHop(envId) !== undefined
    },

    /**
     * The route to `envId`.
     *
     * @returns `undefined` when no path exists, `{ local: true }` for this node, otherwise
     * `{ next }` naming the neighbour to hand the stream to.
     */
    routeTo(envId) {
      if (envId === '' || envId === me) return { done: true }
      const next = nextHop(envId)
      if (next === undefined) return undefined
      if (next === envId) return { done: false, next: envId }
      return { done: false, next }
    },

    /**
     * Forget everything about an environment.
     *
     * Its advertisement goes, and so does every mention of it in someone else's neighbour
     * list — a departed node that stays inside another's adjacency keeps a path alive
     * through a machine that is not there.
     *
     * @returns whether anything was removed.
     */
    forget(envId) {
      let changed = advertisements.delete(envId)
      if (described.delete(envId)) changed = true
      for (const state of advertisements.values()) {
        const before = state.neighbours.length
        state.neighbours = state.neighbours.filter((one) => one !== envId)
        if (state.neighbours.length !== before) changed = true
      }
      return changed
    },

    /**
     * Drop everything learned through one neighbour.
     *
     * @returns how many rows were removed.
     */
    forgetLearnedFrom(source) {
      return this.forget(source) ? 1 : 0
    },

    /**
     * What to flood onwards, with one peer withheld.
     *
     * Withholding is split horizon: telling a peer about links it already sees is wasted,
     * and telling it that a node is reachable *through the peer being told* is how a
     * message goes back the way it came.
     *
     * @param options.exclude - the environment this message is going to.
     * @param options.self - this node's own advertisement, from `selfAdvertisement`.
     */
    outbound({ exclude = '', self = undefined } = {}) {
      const states = [...advertisements.values()]
        .filter((state) => state.envId !== exclude && state.envId !== me)
        // Passed on as received. Filtering the neighbour lists corrupted the facts: with
        // two upstreams, each got a different version of a third node's links, and whichever
        // arrived last erased the other — nodes disappeared from the graph that were
        // connected all along. Duplicate information is discarded by `learn`, which keeps
        // one entry per origin, so flooding still terminates.
        .map((state) => ({ ...state }))
      // This node's own advertisement leads, so a receiver always knows who is speaking
      // and what it is attached to. Without it an edge is a dead end in everyone's graph:
      // it answers streams but nothing can compute a way to it.
      if (me !== '' && self !== undefined) {
        // Not filtered by `exclude`. Split horizon is about not repeating a *route* back to
        // its source; a neighbour list is a fact, and removing an entry from it tells the
        // receiver a link does not exist. With two upstreams each got a different version
        // of this node's own links, and whichever arrived last erased the other — the node
        // came out attached to one upstream and invisible from the rest of the graph.
        states.unshift({ ...self })
      }
      return { from: me, nodes: this.nodes(), states }
    },

    /**
     * This node's own advertisement.
     *
     * The sequence is taken from the view, so every caller here shares one ordering.
     *
     * @param neighbours - the ids this node holds a live direct link to.
     */
    selfAdvertisement(neighbours) {
      ownSeq += 1
      return linkState(me, neighbours, ownSeq)
    },
  }
}
