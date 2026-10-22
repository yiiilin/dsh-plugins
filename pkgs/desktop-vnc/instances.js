/**
 * desktop-vnc Host half — the browser instance table.
 *
 * One process can hold many **browser instances**; this module is the table that
 * remembers them. Each entry owns its own browser stack, its own RFB server and
 * the session that created it (its **实例归属**), and the table is the only thing
 * that knows they exist together.
 *
 * Three rules are load-bearing:
 *
 * - **The id is ours.** It is minted here from `crypto.randomUUID()`, never taken
 *   from bsk or any other external tool: swapping the driver layer must not
 *   change what an agent addresses an instance by.
 * - **Ports are claimed here, synchronously, before any bind — then probed.**
 *   Probe-then-bind is not atomic, so two instances created together would both
 *   see the same port as free and both try to bind it. The table holds the claim
 *   instead, which is why it is handed the port pool. A claim only rules out
 *   *this process*: `boot()` therefore probes the claimed port before building the
 *   backend and walks on when a foreign server already answers there. Adopting
 *   such a server would show another instance's desktop with no error anywhere.
 * - **Ownership belongs to the session.** Closing a session closes its instances;
 *   nothing else does (see `disposeSession`, and the `session/disposed` wiring in
 *   index.js — `agent/disposed` is deliberately not listened to).
 *
 * @module @yiln-dsh/dsh-desktop-vnc/instances
 */

import { randomUUID } from 'node:crypto'

import { probePort } from './x11vnc.js'

/** Short opaque id: eight hex digits is 32 bits of collision space. */
const ID_LENGTH = 8

/** The three states a browser instance can be in, as the list reports them. */
export const INSTANCE_STATES = ['starting', 'ready', 'failed']

/** An id fit for a URL path segment: lowercase hex, fixed length, never a path. */
const ID_PATTERN = new RegExp(`^[0-9a-f]{${ID_LENGTH}}$`)

/**
 * Mint a browser instance id.
 *
 * Short on purpose — it appears in every sidebar row and every agent tool call —
 * and hex-only so it is safe as a URL path segment with no encoding.
 *
 * @returns {string} a fresh id.
 */
export function newInstanceId() {
  return randomUUID().replace(/-/gu, '').slice(0, ID_LENGTH)
}

/** True when `value` has the shape of an id this module minted. */
export function isInstanceId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * An error carrying the HTTP status the route should answer with.
 *
 * The registry is also driven by the agent tools, which never see an HTTP status;
 * they read `message`. Keeping the status on the error lets one close path serve
 * both without a second translation table.
 */
function instanceError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Build the browser instance table.
 *
 * @param {object} options
 * @param {(context: object) => object} options.createBackend builds the browser/vnc/capture trio for one instance.
 * @param {(context: object) => Promise<{display: string}|{error: string}>} [options.prepareDisplay]
 *   resolves and retargets the display for one freshly built backend.
 * @param {number[]} [options.ports] the RFB ports this process may claim, preferred first.
 * @param {(port: number) => Promise<boolean>} [options.probe] reports whether a port
 *   already answers; the default is the real loopback connect probe. Injected so
 *   tests never bind a socket.
 * @param {{width: number, height: number}} [options.viewport] reported size of every instance.
 * @param {() => number} [options.now] clock, for tests.
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @param {(id: string) => void} [options.onClose] called once per closed instance.
 * @returns {object} the registry handle.
 */
export function createInstanceRegistry({
  createBackend,
  prepareDisplay,
  ports = [],
  probe = probePort,
  viewport = { width: 1280, height: 800 },
  now = Date.now,
  log,
  onClose,
} = {}) {
  /** @type {Map<string, object>} insertion order is the list order. */
  const entries = new Map()
  /** Ports claimed by this process, so two boots never reach for the same one. */
  const claimedPorts = new Set()
  /** Callbacks run once per closed instance, in registration order. */
  const closeListeners = new Set()
  if (typeof onClose === 'function') closeListeners.add(onClose)

  /**
   * Subscribe to instance closes.
   *
   * Every close path — an explicit close, a disposed session, unload — funnels
   * through the same hook, so a subscriber never has to watch those paths itself.
   *
   * @param {(id: string) => void} handler called with the closed instance's id.
   * @returns {() => void} the unsubscribe function.
   */
  const subscribeClose = (handler) => {
    if (typeof handler !== 'function') return () => {}
    closeListeners.add(handler)
    return () => {
      closeListeners.delete(handler)
    }
  }

  const note = (level, message) => {
    if (typeof log !== 'function') return
    try {
      log(level, message)
    } catch {
      // Diagnostics must never break the lifecycle.
    }
  }

  /** Milliseconds to the whole seconds the list contract uses. */
  const seconds = (ms) => Math.floor(ms / 1000)

  /**
   * One list row: the only shape the HTTP list and the agent tools report.
   *
   * `error` is conditional on purpose: a `failed` row has to explain itself
   * without a second request, while a `starting`/`ready` row must not carry an
   * empty or `undefined` field — an absent key is the honest "no failure".
   */
  const row = (entry) => {
    const base = {
      id: entry.id,
      state: entry.state,
      width: viewport.width,
      height: viewport.height,
      createdAt: seconds(entry.createdAt),
      ownerSessionId: entry.ownerSessionId,
      lastActiveAt: seconds(entry.lastActiveAt),
      viewers: entry.viewers,
    }
    if (entry.state !== 'failed') return base
    return {
      ...base,
      error: typeof entry.error === 'string' && entry.error !== '' ? entry.error : 'browser instance failed',
    }
  }

  /** Claim the lowest port no live instance of this process holds. */
  const claimPort = () => {
    for (const port of ports) {
      if (!claimedPorts.has(port)) {
        claimedPorts.add(port)
        return port
      }
    }
    return null
  }

  /** Give a port back so the next instance may claim it. */
  const releasePort = (port) => {
    if (Number.isInteger(port)) claimedPorts.delete(port)
  }

  /** True when something already answers on `port`; an unreadable probe is not occupancy. */
  const portTaken = async (port) => {
    try {
      return (await probe(port)) === true
    } catch {
      // An unreadable probe is not proof of occupancy: the bind attempt reports
      // the real failure rather than this one hiding it.
      return false
    }
  }

  /**
   * Confirm the port `create()` reserved is actually free, walking the pool when
   * a foreign server already holds it.
   *
   * `create()` cannot await, so it claims the lowest port this process does not
   * hold; that says nothing about a *foreign* listener. This is where the two are
   * told apart: the reserved port is probed first, and when something answers on
   * it the claim is given back and the pool is walked again.
   *
   * The reserve-then-probe order is what keeps the synchronous guarantee intact
   * for concurrent boots: a candidate enters `claimedPorts` **before** its probe
   * awaits, so a second instance never sees the same port as free, and a port
   * that turns out to be free is simply kept.
   *
   * @param {object} entry the entry whose reserved port to confirm.
   * @returns {Promise<number|null>} a claimed, free port, or null when none is left.
   */
  const confirmPort = async (entry) => {
    const reserved = entry.port
    if (Number.isInteger(reserved) && !await portTaken(reserved)) {
      // close() may have given the claim back while the probe was in flight: the
      // entry must not act on a port it no longer holds.
      if (entry.closed) return null
      // Still ours unless the release above raced: claimPort() only skips ports
      // in `claimedPorts`, so re-adding is a no-op in the normal case.
      claimedPorts.add(reserved)
      return reserved
    }
    if (Number.isInteger(reserved)) releasePort(reserved)
    entry.port = null

    for (const port of ports) {
      // The reserved port was just probed and found taken; walking it again would
      // only repeat the same answer.
      if (port === reserved || claimedPorts.has(port)) continue
      claimedPorts.add(port)
      const taken = await portTaken(port)
      if (entry.closed) {
        claimedPorts.delete(port)
        return null
      }
      if (!taken) {
        entry.port = port
        return port
      }
      claimedPorts.delete(port)
    }
    return null
  }

  /** The 503 an exhausted pool produces, naming what is already open. */
  const exhausted = () => {
    const open = [...entries.values()].map((entry) => `${entry.id}:${entry.state}`).join(', ')
    return instanceError(
      503,
      `没有空闲的 RFB 端口（no free RFB port in the configured range）; open instances: ${open || 'none'}`,
    )
  }

  /** Tear down one entry's stack, best-effort: a failed stop must not block a close. */
  const disposeBackend = async (entry) => {
    const backend = entry.backend
    entry.backend = null
    entry.browser = null
    entry.vnc = null
    entry.capture = null
    if (backend === null || typeof backend.dispose !== 'function') return
    try {
      await backend.dispose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      note('warn', `desktop-vnc: closing browser instance ${entry.id} failed: ${message}`)
    }
  }

  /**
   * Boot one instance: resolve the display, start the browser, start the RFB server.
   *
   * Every failure becomes `state: 'failed'` with a readable `error` rather than a
   * rejected promise the caller could miss — the row is the only report surface.
   *
   * @param {object} entry the entry to boot.
   * @returns {Promise<void>} settles when the entry reaches `ready` or `failed`.
   */
  const boot = async (entry) => {
    try {
      // The port reserved at create() time is only a claim against this process;
      // a foreign listener on it means it was never really free. Confirm before
      // the backend is built, because the backend binds that exact port.
      const port = await confirmPort(entry)
      if (entry.closed) return
      if (port === null) throw exhausted()

      const backend = createBackend({ id: entry.id, port })
      entry.browser = backend.browser ?? null
      entry.vnc = backend.vnc ?? null
      entry.capture = backend.capture ?? null
      entry.backend = backend

      // Closed while the backend was being built: dispose it instead of starting
      // a browser no row points at.
      if (entry.closed) {
        await disposeBackend(entry)
        return
      }

      const target = typeof prepareDisplay === 'function'
        ? await prepareDisplay({ id: entry.id, browser: entry.browser, vnc: entry.vnc, capture: entry.capture })
        : { display: entry.display }
      if (entry.closed) {
        await disposeBackend(entry)
        return
      }
      if (target?.error !== undefined) throw new Error(target.error)
      entry.display = typeof target?.display === 'string' ? target.display : entry.display

      // The RFB server is started lazily, when a viewer actually connects: it is
      // only needed to watch, and starting one per instance up front would burn a
      // process on every browser nobody looks at. `ready` therefore means "the
      // browser is up", which is exactly what the sidebar reports.

      if (entry.closed) {
        await disposeBackend(entry)
        return
      }
      entry.state = 'ready'
      note('info', `desktop-vnc: browser instance ${entry.id} is ready on 127.0.0.1:${entry.port}`)
    } catch (error) {
      if (entry.closed) return
      entry.state = 'failed'
      entry.error = error instanceof Error ? error.message : String(error)
      note('warn', `desktop-vnc: browser instance ${entry.id} failed: ${entry.error}`)
    }
  }

  /**
   * Create one browser instance and answer immediately.
   *
   * The stack boots on a promise the caller never awaits, so the create endpoint
   * returns while Xephyr/Chromium are still coming up; the row's state moves to
   * `ready` or `failed` when that boot settles.
   *
   * @param {{ownerSessionId?: string}} [options] the owning session.
   * @returns {{id: string, state: 'starting'}} the new instance's address and initial state.
   * @throws {Error} with `status: 503` when the port pool is exhausted; the message
   *   names the instances already open so the caller can close one and retry.
   */
  const create = ({ ownerSessionId } = {}) => {
    // Claimed synchronously, before any await, so two concurrent creates cannot
    // both see the same port as free. `boot` then confirms the claim against
    // foreign listeners, which is the part a synchronous claim cannot know.
    const port = claimPort()
    if (port === null) throw exhausted()

    const id = newInstanceId()
    const createdAt = now()
    const entry = {
      id,
      ownerSessionId: typeof ownerSessionId === 'string' && ownerSessionId !== '' ? ownerSessionId : null,
      createdAt,
      lastActiveAt: createdAt,
      state: 'starting',
      viewers: 0,
      browser: null,
      vnc: null,
      capture: null,
      backend: null,
      port,
      display: null,
      error: null,
      // Set when close() wins the race against an in-flight boot, so that boot
      // stops instead of building a stack nobody can address or dispose.
      closed: false,
      ready: null,
    }
    entries.set(id, entry)
    note('info', `desktop-vnc: created browser instance ${id} (owner ${entry.ownerSessionId ?? 'unknown'})`)
    entry.ready = boot(entry)
    return { id, state: 'starting' }
  }

  /** The flat list the sidebar renders, insertion order, no focus and no cap. */
  const list = () => [...entries.values()].map(row)

  /** One entry by id, or undefined; the read side every route and tool uses. */
  const get = (id) => entries.get(id)

  /**
   * The first instance still in the table, for the v1-compatible single-panel
   * routes (`frame.jpg`, `stream.mjpg`, `ws`) which predate the list.
   *
   * @returns {object|undefined} the entry the legacy routes should address.
   */
  const first = () => entries.values().next().value

  /**
   * Close one browser instance by id.
   *
   * An id that is not in the table is an error, never a fallback: the glossary
   * makes the id the only way to name an instance, so guessing "the most recent
   * one" would let an agent act on a browser it did not mean.
   *
   * @param {string} id the instance to close.
   * @returns {Promise<{closed: true}>} the close acknowledgement.
   * @throws {Error} with `status: 404` when no such instance exists.
   */
  const close = async (id) => {
    const entry = entries.get(id)
    if (entry === undefined) {
      throw instanceError(404, `没有这个浏览器实例（no such browser instance: ${id}）`)
    }
    // Drop the row first: a boot still in flight must not re-add an instance
    // nobody can address, and a concurrent close must see the table already changed.
    entries.delete(id)
    entry.closed = true
    releasePort(entry.port)
    entry.port = null
    entry.state = 'failed'
    entry.error = 'closed'

    await disposeBackend(entry)
    note('info', `desktop-vnc: closed browser instance ${id}`)
    for (const listener of closeListeners) {
      try {
        listener(id)
      } catch {
        // A listener must not turn a completed close into a failure.
      }
    }
    return { closed: true }
  }

  /**
   * Close every instance one session created.
   *
   * This is the **实例归属** rule: the session that created an instance owns it, so
   * when that session disappears its instances do too. Other sessions' entries are
   * untouched, which is the whole reason the owner is recorded.
   *
   * @param {string} sessionId the disposed session.
   * @returns {Promise<string[]>} the ids that were closed.
   */
  const disposeSession = async (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    const owned = [...entries.values()].filter((entry) => entry.ownerSessionId === sessionId)
    const closed = []
    for (const entry of owned) {
      try {
        await close(entry.id)
        closed.push(entry.id)
      } catch {
        // Already gone (a concurrent close): nothing left to do for this one.
      }
    }
    if (closed.length > 0) {
      note('info', `desktop-vnc: closed ${closed.length} browser instance(s) owned by session ${sessionId}`)
    }
    return closed
  }

  /**
   * Record one more client watching an instance.
   *
   * Watching counts as activity, so `lastActiveAt` moves: a row that says "active
   * 20 minutes ago" while two people are looking at it would be a lie.
   *
   * @param {string} id the instance being watched.
   * @returns {number|undefined} the new count, or undefined for an unknown id.
   */
  const attachViewer = (id) => {
    const entry = entries.get(id)
    if (entry === undefined) return undefined
    entry.viewers += 1
    entry.lastActiveAt = now()
    return entry.viewers
  }

  /**
   * Record one fewer client watching an instance, never below zero.
   *
   * @param {string} id the instance that lost a viewer.
   * @returns {number|undefined} the new count, or undefined for an unknown id.
   */
  const detachViewer = (id) => {
    const entry = entries.get(id)
    if (entry === undefined) return undefined
    entry.viewers = Math.max(0, entry.viewers - 1)
    entry.lastActiveAt = now()
    return entry.viewers
  }

  /**
   * Close every instance this process holds, for plugin unload.
   *
   * @returns {Promise<string[]>} the ids that were closed.
   */
  const disposeAll = async () => {
    const ids = [...entries.keys()]
    for (const id of ids) {
      try {
        await close(id)
      } catch {
        // Already gone.
      }
    }
    return ids
  }

  return {
    create,
    list,
    get,
    first,
    close,
    subscribeClose,
    disposeSession,
    disposeAll,
    attachViewer,
    detachViewer,
    row,
    seconds,
    entries,
    claimedPorts,
    viewport,
  }
}
