/**
 * Source routing across the federation.
 *
 * A request names the environments it must pass through, in order, and every node does
 * the same three things with that queue:
 *
 * 1. The head is my own id → drop it and answer the request locally.
 * 2. The head is someone else → forward the request down the tunnel that reaches them.
 * 3. The queue is empty → this is a local request; the caller answers it directly.
 *
 * That is the whole model. A node never needs to know whether it is "the main node" or
 * "an edge": it needs to know which tunnels it holds and which environment each one
 * reaches. Before this, the same three-way branch (`self` / `role === 'main'` /
 * everything else) was written once per capability, sixteen times over, and writing it
 * wrong was not hypothetical — an edge once asked its own tunnel table whether a *peer*
 * was online, which is always false there, so every edge-to-edge message reported
 * "offline".
 *
 * The topology is a star: an edge holds one tunnel to the main node and no others, so a
 * route to a peer is `[peer]` and the main node is the node that happens to hold the
 * tunnel, not a special case in the routing.
 *
 * @module @yiln-dsh/dsh-gateway/federation/routing
 */

/**
 * What to do with one hop of a route.
 *
 * @param route - the target queue; may be empty.
 * @param selfId - this node's environment id.
 * @returns `{ kind: 'local' }` when the request is for this node, otherwise
 *   `{ kind: 'forward', next, rest }` naming the hop to take and the queue to send on.
 */
export function nextHop(route, selfId) {
  const queue = Array.isArray(route) ? route.filter((id) => typeof id === 'string' && id !== '') : []
  if (queue.length === 0) return { kind: 'local' }
  const [head, ...rest] = queue
  if (head === selfId) {
    // The request arrived. The remainder of the queue names nodes *this* one is not, which
    // means the route asked to pass through here and then carry on — a case no current
    // caller produces, and one that would silently drop the request if ignored.
    if (rest.length > 0) {
      return { kind: 'invalid', error: `route continues past this node: ${rest.join(' → ')}` }
    }
    return { kind: 'local' }
  }
  return { kind: 'forward', next: head, rest }
}

/**
 * Reserve the last hop before handing the request over.
 *
 * A node forwards with the queue it received, minus its own decision. Whatever arrives at
 * the far end therefore still names the destination, which is how that node knows the
 * request is for it.
 *
 * @param route - the queue as received.
 * @returns the queue to put on the wire.
 */
export function routeOnward(route) {
  return Array.isArray(route) ? [...route] : []
}

/**
 * Refuse a route that cannot make progress.
 *
 * @param route - the queue.
 * @param selfId - this node's id.
 * @returns an error string, or nothing when the route is well formed.
 */
export function validateRoute(route, selfId) {
  if (!Array.isArray(route)) return 'route must be an array of environment ids'
  if (route.some((id) => typeof id !== 'string' || id === '')) return 'route entries must be non-empty strings'
  // A route that names this node anywhere but the head can never be satisfied: the request
  // would have to leave here and come back, which is a loop.
  const firstSelf = route.indexOf(selfId)
  if (firstSelf > 0) return `route revisits this node at position ${firstSelf}`
  if (new Set(route).size !== route.length) return 'route repeats an environment'
  return undefined
}
