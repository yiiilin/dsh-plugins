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
  displays = [],
  probeDisplay = undefined,
  cdpPorts = [],
  probeCdp = undefined,
  viewport = { width: 1280, height: 800 },
  now = Date.now,
  log,
  onClose,
} = {}) {
  /** @type {Map<string, object>} insertion order is the list order. */
  const entries = new Map()
  /** Ports claimed by this process, so two boots never reach for the same one. */
  const claimedPorts = new Set()
  /**
   * Nested displays claimed by this process.
   *
   * The port claim exists because probing is not atomic: two boots in the same
   * tick both see a free port and race for it. Displays have exactly the same
   * shape of race — two `pickFreeDisplay` calls both see `:N` free because
   * neither has written its lock file yet, both start Xephyr on `:N`, and the
   * loser dies with exit code 1 while its row still says `starting`. Claiming
   * the number here is the only thing that makes the choice atomic; the browser
   * stack is then handed the claimed display instead of probing for its own.
   */
  const claimedDisplays = new Set()
  /**
   * Debug ports claimed by this process.
   *
   * Same race as the RFB port and the display: the probe cannot be atomic, so the
   * claim lands before any await. Without a port per instance the id names a
   * window nothing can drive, and a model falls back to a browser of its own.
   */
  const claimedCdpPorts = new Set()
  /** How long a debug port gets to answer before the instance is called failed. */
  const CDP_READY_TIMEOUT_MS = 8000
  /** How often the debug port is re-probed while waiting. */
  const CDP_READY_POLL_MS = 150
  /** Fallback occupancy probe for a debug port, when the caller supplies none. */
  const cdpPortTaken = async (port) => {
    if (typeof probeCdp !== 'function') return false
    try {
      return (await probeCdp(port)) === true
    } catch {
      return false
    }
  }
  /** Fallback occupancy probe for a display candidate, when the caller supplies none. */
  const displayTaken = async (display) => {
    if (typeof probeDisplay !== 'function') return false
    try {
      return (await probeDisplay(display)) === true
    } catch {
      // An unreadable probe is not proof of occupancy: the start attempt reports
      // the real failure rather than this one hiding it.
      return false
    }
  }
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
      // The instance's own size, not a global: two browsers can be sized
      // differently, and the list has to say which is which.
      width: entry.width,
      height: entry.height,
      createdAt: seconds(entry.createdAt),
      ownerSessionId: entry.ownerSessionId,
      lastActiveAt: seconds(entry.lastActiveAt),
      viewers: entry.viewers,
    }
    // The debug port is what makes the id actionable: it is the argument
    // `agent-browser connect` needs to drive *this* browser rather than launch one.
    if (Number.isInteger(entry.cdpPort)) base.cdpPort = entry.cdpPort
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

  /**
   * Claim the first display no live instance of this process holds.
   *
   * Synchronous on purpose: the claim must land before any await, or two creates
   * in the same tick both see the same number as free — the exact race the port
   * claim already prevents. `confirmDisplay` then re-checks the candidate against
   * the real display sockets, because a synchronous claim cannot know whether a
   * foreign X server already owns it.
   *
   * @returns {string|null} a display such as `:200`, or null when the pool is full.
   */
  const claimDisplay = () => {
    for (const display of displays) {
      if (!claimedDisplays.has(display)) {
        claimedDisplays.add(display)
        return display
      }
    }
    return null
  }

  /** Give a display back so the next instance may claim it. */
  const releaseDisplay = (display) => {
    if (typeof display === 'string') claimedDisplays.delete(display)
  }

  /** Claim the lowest debug port no live instance of this process holds. */
  const claimCdpPort = () => {
    for (const port of cdpPorts) {
      if (!claimedCdpPorts.has(port)) {
        claimedCdpPorts.add(port)
        return port
      }
    }
    return null
  }

  /** Give a debug port back so the next instance may claim it. */
  const releaseCdpPort = (port) => {
    if (Number.isInteger(port)) claimedCdpPorts.delete(port)
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
   * Confirm the resource `create()` reserved for one entry, or claim another from
   * its pool.
   *
   * All three reserved resources — the RFB port, the nested display and the debug
   * port — share one lifecycle rule: the synchronous claim at `create()` only
   * proves no other instance of this process holds the number; a foreign owner is
   * discovered here, and the claim then walks the pool for the next free one.
   * Writing that rule once (rather than three times) is what keeps a fix to it
   * from having to land in three places, which is exactly how the display race
   * and the dead debug port both survived review.
   *
   * The caller supplies only what differs: the entry field, the pool, its claim
   * set, the readiness probe, and how to release and read a candidate.
   *
   * @param {object} entry the entry whose reservation to confirm.
   * @param {object} spec the resource-specific parts.
   * @param {string} spec.field entry field holding the reservation.
   * @param {Array<string|number>} spec.pool candidate resources, in claim order.
   * @param {Set<string|number>} spec.claimed resources this process holds.
   * @param {(candidate: string|number) => Promise<boolean>} spec.taken is it taken?
   * @param {(candidate: string|number) => void} spec.release give a claim back.
   * @param {(value: unknown) => boolean} spec.usable is a value a real candidate?
   * @returns {Promise<string|number|null>} the confirmed resource, or null when none is left.
   */
  const confirmResource = async (entry, { field, pool, claimed, taken, release, usable }) => {
    const reserved = entry[field]
    if (usable(reserved) && !await taken(reserved)) {
      // close() may have given the claim back while the probe was in flight: the
      // entry must not act on a resource it no longer holds.
      if (entry.closed) return null
      claimed.add(reserved)
      return reserved
    }
    if (usable(reserved)) release(reserved)
    entry[field] = null

    for (const candidate of pool) {
      // The reserved one was just probed and found taken; walking it again would
      // only repeat the same answer.
      if (candidate === reserved || claimed.has(candidate)) continue
      claimed.add(candidate)
      const isTaken = await taken(candidate)
      if (entry.closed) {
        claimed.delete(candidate)
        return null
      }
      if (!isTaken) {
        entry[field] = candidate
        return candidate
      }
      claimed.delete(candidate)
    }
    return null
  }

  /** Confirm the RFB port `create()` reserved, walking the pool when it is taken. */
  const confirmPort = (entry) => confirmResource(entry, {
    field: 'port',
    pool: ports,
    claimed: claimedPorts,
    taken: portTaken,
    release: releasePort,
    usable: Number.isInteger,
  })

  /** Confirm the nested display `create()` reserved, walking the pool when taken. */
  const confirmDisplay = (entry) => confirmResource(entry, {
    field: 'displayClaim',
    pool: displays,
    claimed: claimedDisplays,
    taken: displayTaken,
    release: releaseDisplay,
    usable: (value) => typeof value === 'string' && value !== '',
  })

  /** Confirm the debug port `create()` reserved, walking the pool when taken. */
  const confirmCdpPort = (entry) => confirmResource(entry, {
    field: 'cdpPort',
    pool: cdpPorts,
    claimed: claimedCdpPorts,
    taken: cdpPortTaken,
    release: releaseCdpPort,
    usable: Number.isInteger,
  })

  /**
   * Wait until the debug port answers, or give up.
   *
   * Chromium publishes its CDP endpoint a moment after the window appears, so a
   * single probe right after `prepareDisplay` is a race. The bound is short: a
   * port that never answers means the browser did not take it, and a row that
   * says `ready` must not outlive that fact.
   *
   * @param {number} port the debug port to wait for.
   * @returns {Promise<boolean>} true once it accepts a connection.
   */
  const waitForCdpPort = async (port) => {
    const deadline = Date.now() + CDP_READY_TIMEOUT_MS
    for (;;) {
      if (await cdpPortTaken(port)) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => { setTimeout(resolve, CDP_READY_POLL_MS) })
    }
  }

  /** The 503 an exhausted pool produces, naming what is already open. */
  const exhausted = () => {
    const open = [...entries.values()].map((entry) => `${entry.id}:${entry.state}`).join(', ')
    return instanceError(
      503,
      `没有空闲的 RFB 端口（no free RFB port in the configured range）; open instances: ${open || 'none'}`,
    )
  }

  /** The 503 an exhausted nested-display pool produces, naming what is open. */
  const exhaustedDisplay = () => {
    const open = [...entries.values()].map((entry) => `${entry.id}:${entry.state}`).join(', ')
    return instanceError(
      503,
      `没有空闲的嵌套显示号（no free nested display in the configured range）; open instances: ${open || 'none'}`,
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

      // `undefined` when no display pool is configured: the stack then picks its
      // own number, as it did before the pool existed.
      const display = entry.displayClaim === undefined
        ? undefined
        : await confirmDisplay(entry)
      if (entry.closed) return
      if (display === null) throw exhaustedDisplay()

      // `undefined` when no debug-port pool is configured: the stack then launches
      // without one, as it did before the pool existed.
      const cdpPort = entry.cdpPort === undefined
        ? undefined
        : await confirmCdpPort(entry)
      if (entry.closed) return
      if (cdpPort === null) throw instanceError(503, '没有空闲的调试端口（no free debug port in the configured range）')

      const backend = createBackend({
        id: entry.id,
        port,
        display,
        cdpPort,
        width: entry.width,
        height: entry.height,
      })
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
      // `ready` promises the caller can drive this browser, so the debug port has
      // to be answering before the row says so. Chromium asked to bind an occupied
      // number may exit, or quietly fall back to another address; either way the
      // `cdpPort` on the row would be a port nothing listens on, and a model
      // following it would fail to connect and fall back to a browser of its own.
      //
      // Skipped when the display choice reports that no browser was started: the
      // v1 path mirrors the host desktop and owns no debug port, so demanding one
      // would fail a configuration that is working as designed.
      const startedBrowser = target?.browser !== false
      if (startedBrowser && cdpPort !== undefined && !await waitForCdpPort(cdpPort)) {
        throw new Error(`调试端口 ${cdpPort} 未就绪（debug port ${cdpPort} never accepted a connection）`)
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
  const create = ({ ownerSessionId, width, height } = {}) => {
    // Claimed synchronously, before any await, so two concurrent creates cannot
    // both see the same port as free. `boot` then confirms the claim against
    // foreign listeners, which is the part a synchronous claim cannot know.
    const port = claimPort()
    if (port === null) throw exhausted()

    // Claimed in the same synchronous block as the port, for the same reason: the
    // display probe cannot be atomic, so two creates in one tick would otherwise
    // both land on the same number and the losing Xephyr would die on startup.
    //
    // An empty pool means "not configured" rather than "exhausted": a caller that
    // supplies no displays keeps the old behaviour, where the browser stack picks
    // its own number. Production always supplies the pool (see `nestedDisplays`).
    const displayClaim = displays.length === 0 ? undefined : claimDisplay()
    if (displayClaim === null) {
      releasePort(port)
      throw exhaustedDisplay()
    }

    // Claimed in the same synchronous block, for the same reason as the port and
    // the display: the probe cannot be atomic.
    const cdpPort = cdpPorts.length === 0 ? undefined : claimCdpPort()
    if (cdpPort === null) {
      releasePort(port)
      releaseDisplay(displayClaim)
      throw instanceError(503, '没有空闲的调试端口（no free debug port in the configured range）')
    }

    const id = newInstanceId()
    const createdAt = now()
    const entry = {
      id,
      ownerSessionId: typeof ownerSessionId === 'string' && ownerSessionId !== '' ? ownerSessionId : null,
      createdAt,
      lastActiveAt: createdAt,
      // Resolved at creation and stored per instance: `createBackend` builds the
      // window from these, and the row reports them back so a caller can tell two
      // differently-sized browsers apart.
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : viewport.width,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : viewport.height,
      state: 'starting',
      viewers: 0,
      browser: null,
      vnc: null,
      capture: null,
      backend: null,
      port,
      display: null,
      // The nested display reserved for this instance, confirmed in `boot` before
      // the backend is built. Distinct from `display`, which only carries a value
      // once the stack has actually started on it.
      displayClaim,
      // The CDP port an agent drives this browser through, and the title it shows
      // on the desktop. Both are per-instance identity, not decoration.
      cdpPort,
      error: null,
      // Set when close() wins the race against an in-flight boot, so that boot
      // stops instead of building a stack nobody can address or dispose.
      closed: false,
      ready: null,
    }
    entries.set(id, entry)
    note('info', `desktop-vnc: created browser instance ${id} (owner ${entry.ownerSessionId ?? 'unknown'})`)
    entry.ready = boot(entry)
    // `cdpPort` is part of the answer, not a detail of the row: it is the argument
    // the caller needs to drive the window it just opened.
    return {
      id,
      state: 'starting',
      // The size the caller asked for (or the configured default) belongs in the
      // answer: it is what the window was built at, and the list reports it back.
      width: entry.width,
      height: entry.height,
      ...(cdpPort === undefined ? {} : { cdpPort }),
    }
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
    // The display claim is released with the port: a closed instance must not keep
    // a nested display number reserved, or the pool leaks one number per close.
    releaseDisplay(entry.displayClaim)
    entry.displayClaim = null
    releaseCdpPort(entry.cdpPort)
    entry.cdpPort = null
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
   * Record a new size for one instance.
   *
   * The record is what the list reports and what the next `browser.ensure()` would
   * build from; applying the size to a *running* browser is the caller's job,
   * because the mechanism (a CDP viewport override) lives outside this table.
   *
   * @param {string} id the instance to resize.
   * @param {{width?: number, height?: number}} size the requested size.
   * @returns {{id: string, width: number, height: number}|undefined} the applied size,
   *   or undefined for an unknown id.
   */
  const resize = async (id, { width, height } = {}) => {
    const entry = entries.get(id)
    if (entry === undefined) return undefined
    if (Number.isFinite(width) && width > 0) entry.width = Math.round(width)
    if (Number.isFinite(height) && height > 0) entry.height = Math.round(height)
    entry.lastActiveAt = now()
    // The browser stack owns how a live window takes a new size; when it has no
    // such seam the record still changes, so the list is honest about what was
    // asked for even though the running page keeps its old viewport.
    const apply = entry.backend?.resize
    if (typeof apply === 'function') {
      try {
        await apply({ width: entry.width, height: entry.height })
      } catch (error) {
        entry.lastActiveAt = now()
        throw error
      }
    }
    return { id: entry.id, width: entry.width, height: entry.height }
  }

  /**
   * Type text into one instance's focused element.
   *
   * The text goes through the browser stack rather than the RFB clipboard: that
   * clipboard is ISO 8859-1 only on this x11vnc, so anything outside Latin-1 would
   * arrive as question marks.
   *
   * @param {string} id the instance to type into.
   * @param {string} text the text to type.
   * @returns {Promise<{id: string}|undefined>} the instance id, or undefined when unknown.
   */
  const typeText = async (id, text) => {
    const entry = entries.get(id)
    if (entry === undefined) return undefined
    if (typeof text !== 'string' || text === '') return { id: entry.id }
    const apply = entry.backend?.typeText
    if (typeof apply !== 'function') throw new Error('this browser instance cannot take typed text')
    await apply(text)
    entry.lastActiveAt = now()
    return { id: entry.id }
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
    resize,
    typeText,
    row,
    seconds,
    entries,
    claimedPorts,
    viewport,
  }
}
