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
  let current
  let me = selfId

  return {
    /**
     * Learn which environment this node is.
     *
     * A leaf knows only its token; the main node knows which environment the token
     * belongs to and says so in the broadcast. Without it `routeTo` cannot tell "the
     * destination is me" from "the destination is a peer".
     */
    setSelfId(envId) {
      me = envId
    },
    /** Adopt a snapshot if it is newer than what is held. @returns whether it was adopted. */
    apply(incoming) {
      if (!isNewer(current, incoming)) return false
      current = incoming
      return true
    },
    /** Every node row, this node included. */
    nodes() {
      return current === undefined ? [] : [...current.nodes]
    },
    /** Every edge row. */
    edges() {
      return current === undefined ? [] : [...current.edges]
    },
    /** The row for one environment, or undefined. */
    get(envId) {
      return current?.nodes.find((row) => row.envId === envId)
    },
    /**
     * The next hop toward `envId`, or `undefined` when this node has no route.
     *
     * `{ done: true }` means the destination is this node — the caller answers locally.
     * `{ next: '' }` means a direct tunnel. `{ next: 'x' }` means hand the stream to `x`.
     */
    routeTo(envId) {
      if (envId === '' || envId === me) return { done: true }
      const edge = current?.edges.find((row) => row.to === envId)
      if (edge === undefined) return undefined
      return { done: false, next: edge.via }
    },
    /** The raw snapshot, for diagnostics. */
    get snapshot() {
      return current
    },
  }
}
