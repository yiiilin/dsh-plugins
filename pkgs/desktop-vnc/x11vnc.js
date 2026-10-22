/**
 * desktop-vnc Host half — x11vnc process lifecycle.
 *
 * The panel is useless without a VNC server on `127.0.0.1:<rfbPort>`, so the
 * plugin starts and owns one: `ensure()` allocates a port out of the configured
 * range and spawns `x11vnc` against the configured display. Two properties are
 * load-bearing:
 *
 * - **Never touch a process this controller did not start.** A port already in
 *   listening state belongs to somebody else's VNC server (a system unit, an
 *   earlier `x11vnc` invocation, another instance in this process) and is
 *   *skipped*, not adopted: connecting to a foreign server would make this
 *   panel silently show another instance's desktop with no error anywhere.
 *   Only the server this controller started is reused, and only it is stopped.
 * - **One spawn under concurrency.** The sidebar can mount, remount and open two
 *   tabs while a previous `ensure()` is still polling the port, so the in-flight
 *   promise is shared instead of starting one x11vnc per caller.
 *
 * In v2 the mirrored display is not known when the controller is built: the
 * browser stack picks the nested Xephyr display lazily, and only the request
 * handler that triggers `browser.ensure()` learns it. `setDisplay()` therefore
 * retargets the controller, and a display change invalidates a process started
 * against the previous display so the next `ensure()` respawns correctly.
 *
 * `spawn` and `resolveExecutable` are injected so unit tests never start a real
 * process; production passes the Host `subprocess` service.
 *
 * @module @yiln-dsh/dsh-desktop-vnc/x11vnc
 */

import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'

/** How long a freshly spawned x11vnc gets to bind its port. */
const DEFAULT_START_TIMEOUT_MS = 4000
/** Interval between port probes while waiting for the bind. */
const DEFAULT_PROBE_INTERVAL_MS = 120
/** Single TCP connect probe budget. */
const DEFAULT_PROBE_TIMEOUT_MS = 300
/** Collected stdout/stderr cap; x11vnc's own chatter is never surfaced raw. */
const LOG_CAPTURE_BYTES = 16 * 1024
/** Default RFB range: the VNC display numbers, one port per instance. */
const DEFAULT_PORT_RANGE_MIN = 5900
const DEFAULT_PORT_RANGE_MAX = 5999

/**
 * Resolve when `127.0.0.1:<port>` accepts a TCP connection.
 * @param {number} port target port.
 * @param {{timeoutMs?: number}} [options] connect budget.
 * @returns {Promise<boolean>} true when something is listening.
 */
export function probePort(port, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      finish(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

/** Turn any spawn failure into one readable, non-stack line for the panel. */
export function describeSpawnError(error, executable) {
  const code = error?.code
  const text = typeof error?.message === 'string' ? error.message : String(error ?? '')
  if (code === 'ENOENT' || /not found on PATH|is not an executable file/i.test(text)) {
    return `${executable} 未安装（${executable} not installed）`
  }
  if (code === 'EACCES' || /EACCES/i.test(text)) {
    return `${executable} 不可执行（permission denied）`
  }
  const first = text.split('\n')[0].trim()
  return first === '' ? `无法启动 ${executable}` : first.slice(0, 300)
}

/** The argv the contract freezes for a local-only, passwordless, shared server. */
export function x11vncArgv(executable, { display, port }) {
  return [
    executable,
    '-display', display,
    '-rfbport', String(port),
    '-localhost',
    '-nopw',
    '-forever',
    '-shared',
    '-quiet',
    '-noxdamage',
    '-repeat',
    '-nowf',
  ]
}

/** A port number fit for `-rfbport`; anything else falls back to 5900. */
export function normalizePort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5900
}

/**
 * The inclusive port range an instance allocates from.
 *
 * A malformed range falls back to `[5900, 5999]` rather than reaching a bind,
 * and a reversed one is put back in order instead of silently matching nothing.
 *
 * @param {unknown} value the configured `rfbPortRange`.
 * @returns {{min: number, max: number}} the range in force.
 */
export function normalizePortRange(value) {
  const fallback = { min: DEFAULT_PORT_RANGE_MIN, max: DEFAULT_PORT_RANGE_MAX }
  if (!Array.isArray(value) || value.length !== 2) return fallback
  const [first, second] = value.map((entry) => Number(entry))
  const usable = (port) => Number.isInteger(port) && port > 0 && port < 65536
  if (!usable(first) || !usable(second)) return fallback
  return first <= second ? { min: first, max: second } : { min: second, max: first }
}

/**
 * The ports to try, in order, for one instance.
 *
 * The range is the pool, taken low to high — that is the v2 rule, and it is what
 * keeps two instances from landing on the same port. The v1 single value
 * `rfbPort` is kept working by moving it to the front of that pool:
 *
 * - inside the range, it is simply tried first, so an existing profile keeps the
 *   exact port it had while a second instance falls through to the next free one;
 * - outside the range, it is still honoured when the range is the *default* one,
 *   so a v1 profile with an unusual port does not silently move. A range the
 *   operator actually chose is authoritative and is not widened by a stale field.
 *
 * @param {{rfbPortRange?: unknown, rfbPort?: unknown}} [config] plugin Config.
 * @returns {number[]} candidate ports, preferred first, without duplicates.
 */
export function portCandidates(config = {}) {
  const explicit = config?.rfbPortRange !== undefined && config?.rfbPortRange !== null
  const range = normalizePortRange(config?.rfbPortRange)
  const pool = []
  for (let candidate = range.min; candidate <= range.max; candidate += 1) pool.push(candidate)
  if (config?.rfbPort === undefined || config?.rfbPort === null) return pool
  const preferred = normalizePort(config.rfbPort)
  const rest = pool.filter((candidate) => candidate !== preferred)
  if (pool.includes(preferred)) return [preferred, ...rest]
  const isDefaultRange = range.min === DEFAULT_PORT_RANGE_MIN && range.max === DEFAULT_PORT_RANGE_MAX
  return explicit || !isDefaultRange ? rest : [preferred, ...rest]
}

/**
 * A display spec fit for `-display`: a local `:N` only.
 *
 * x11vnc receives this as an argv element, so anything that could read as a
 * flag (`--help`) or as a remote display is refused and `:0` is used instead.
 * Both the configuration and the v2 retarget path go through this.
 *
 * @param {unknown} value candidate display.
 * @param {string} [fallback] value returned when `value` is not a local display.
 * @returns {string} the accepted display.
 */
export function normalizeDisplay(value, fallback = ':0') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^:[0-9]{1,3}(\.[0-9]{1,3})?$/.test(trimmed) ? trimmed : fallback
}

/**
 * Build the x11vnc controller.
 *
 * @param {object} options
 * @param {(spec: object) => object} options.spawn starts a child and returns a live handle (`done`/`terminate`/`waitForExit`).
 * @param {() => Promise<string>} [options.resolveExecutable] resolves the `x11vnc` path, rejecting when absent.
 * @param {object} [options.config] plugin Config (enabled, display, rfbPort, cwd).
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @param {number} [options.startTimeoutMs] override for the bind wait.
 * @param {number} [options.probeIntervalMs] override for the probe cadence.
 * @param {(port: number) => Promise<boolean>} [options.probe] port probe override, for tests.
 * @returns {{ensure: () => Promise<object>, stop: () => Promise<void>, status: () => object, dispose: () => Promise<void>}} controller.
 */
export function createX11VncController({
  spawn,
  resolveExecutable,
  config = {},
  log,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
  probe = probePort,
} = {}) {
  // Mutable in v2: the nested display is chosen lazily by the browser stack, so
  // the request that ensures the browser retargets this controller before the
  // first ensure(). `displayFor` remembers which display the owned child was
  // started against, so a retarget can retire a now-wrong process.
  let display = normalizeDisplay(config.display)
  // The cookie the display trusts. Set alongside the display, once the browser
  // stack has picked its nested one.
  let authority = null
  let displayFor = null
  // The ports this instance may take, preferred first, and the one it holds.
  // `port` is null until an allocation succeeds; it is the port this controller
  // spawned against, so a foreign listener on the same number is never mistaken
  // for our own server.
  const candidates = portCandidates(config)
  const range = normalizePortRange(config.rfbPortRange)
  let port = null
  const cwd = typeof config.cwd === 'string' && config.cwd !== '' ? config.cwd : tmpdir()
  const enabled = config.enabled !== false

  /** @type {object|null} the handle of the process THIS controller started. */
  let handle = null
  /** @type {Promise<object>|null} in-flight ensure(), shared by concurrent callers. */
  let starting = null
  /** @type {{handle: object, reason: string}|null} exit facts of the last self-started child. */
  let exitInfo = null
  let terminated = false
  /**
   * Children the plugin asked to stop. Membership is checked by the exit
   * watcher, so an exit we requested is reported at info level instead of as a
   * warning — and the check is immune to microtask ordering between
   * `waitForExit()` and the handle's own `done` resolution.
   */
  const requestedStops = new WeakSet()

  const note = (level, message) => {
    if (typeof log === 'function') {
      try {
        log(level, message)
      } catch {
        // Diagnostics must never break the lifecycle.
      }
    }
  }

  /** Collected output of a handle, as one trimmed line, for the exit report. */
  const collectedText = (owner, stream) => {
    const reader = owner?.collected?.[stream]
    if (reader === undefined || reader === null) return ''
    try {
      return reader.readFrom(0).text.trim()
    } catch {
      return ''
    }
  }

  const clearHandle = () => {
    handle = null
    displayFor = null
  }

  /** Watch the child so its exit is recorded once instead of probed repeatedly. */
  const watch = (started) => {
    const settled = Promise.resolve(started.done).then(
      (result) => {
        const reason = result && result.exitCode !== null && result.exitCode !== undefined
          ? `x11vnc exited with code ${result.exitCode}`
          : 'x11vnc exited'
        exitInfo = { handle: started, reason }
        return { reason }
      },
      (error) => {
        const reason = describeSpawnError(error, 'x11vnc')
        exitInfo = { handle: started, reason }
        return { reason }
      },
    )
    settled.then(({ reason }) => {
      const stderr = collectedText(started, 'stderr')
      // An exit we asked for is the expected outcome of stop()/dispose(), not a
      // failure the operator needs to see.
      if (requestedStops.has(started)) {
        note('info', `desktop-vnc: ${reason} (requested)`)
      } else if (stderr !== '') {
        note('warn', `desktop-vnc: ${reason}: ${stderr.split('\n')[0]}`)
      } else {
        note('warn', `desktop-vnc: ${reason}`)
      }
      // Only forget the handle if it is still the current one: a later ensure()
      // may already have replaced it.
      if (handle === started) clearHandle()
    })
    // `done` may reject for a spawn failure; the rejection is handled above.
    settled.catch(() => {})
  }

  /** Reason this child stopped, when it already has; null while it is still alive. */
  const exitReasonFor = (started) => (exitInfo !== null && exitInfo.handle === started ? exitInfo.reason : null)

  /** True once this child has reported an outcome. */
  const hasExited = (started) => Promise.resolve(started.done).then(
    () => true,
    () => true,
  )

  /** True while the child this controller started is still alive. */
  const ownsLiveServer = () => handle !== null && port !== null && exitReasonFor(handle) === null

  /**
   * Claim a port out of the configured range, lowest first.
   *
   * A port that already answers belongs to somebody else — a system unit, an
   * earlier x11vnc, another instance of this plugin — and is **skipped**. The
   * one exception is the port this controller's own live child holds, which is
   * what "reuse" now means: connecting to a foreign server instead would show
   * that instance's desktop in this panel with no error to notice.
   *
   * @returns {Promise<number|null>} the claimed port, or null when the range is full.
   */
  const allocatePort = async () => {
    if (ownsLiveServer()) return port
    for (const candidate of candidates) {
      let taken = false
      try {
        taken = (await probe(candidate)) === true
      } catch {
        // An unreadable probe is not proof of occupancy: the bind attempt reports
        // the real failure rather than this one hiding it.
        taken = false
      }
      if (!taken) return candidate
    }
    return null
  }

  /** Wait until the port answers, or give up and report why. */
  const waitForBind = async (started, boundPort) => {
    const exited = hasExited(started)
    let done = false
    exited.then(() => {
      done = true
    })
    const deadline = Date.now() + startTimeoutMs
    for (;;) {
      if (await probe(boundPort)) return true
      if (done) return false
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, probeIntervalMs)
        timer.unref?.()
      })
    }
  }

  /**
   * Report the current state and, when a self-started process should exist, its
   * liveness. The shape stays exactly `{ running, port, pid? }` — v1 consumers
   * (and the frozen tests) read it directly, and the mirrored display is
   * reported separately through {@link display}.
   */
  const status = () => {
    // Before the first allocation the preferred port is reported, so the shape
    // stays a number and a v1 consumer sees the port it configured.
    const result = { running: false, port: port ?? candidates[0] }
    if (handle !== null && exitReasonFor(handle) === null) {
      result.running = true
      if (typeof handle.pid === 'number') result.pid = handle.pid
    }
    return result
  }

  /**
   * Retarget the mirrored display (v2: the nested display the browser stack
   * picked). An owned child started against a different display no longer
   * mirrors what the panel shows, so it is stopped — only if it is ours — and
   * the next `ensure()` starts a fresh one. A pre-existing server is never
   * touched: it is merely reused under the new display.
   *
   * @param {unknown} value the display the panel should see.
   * @returns {string} the display the controller now targets.
   */
  /**
   * Point the server at the Xauthority its display trusts.
   *
   * Access control is on for that display, so the RFB server presents the same
   * cookie the browser does; without it x11vnc exits with "Authorization
   * required" and the panel's websocket is answered with a 503.
   *
   * @param value - the file the browser stack wrote, or nothing to leave it unset.
   * @returns the authority now in force.
   */
  const setAuthority = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return authority
    const next = value.trim()
    if (next === authority) return authority
    authority = next
    // A different cookie means the running server trusts an older one: retire it
    // and let the next ensure() start it again against this file.
    if (handle !== null) {
      const stale = handle
      requestedStops.add(stale)
      clearHandle()
      port = null
      try {
        stale.terminate?.()
      } catch {
        // Already gone.
      }
    }
    return authority
  }

  const setDisplay = (value) => {
    const next = normalizeDisplay(value, display)
    if (next === display) return display
    display = next
    if (handle !== null && displayFor !== null && displayFor !== next) {
      const stale = handle
      requestedStops.add(stale)
      clearHandle()
      port = null
      try {
        stale.terminate?.()
      } catch {
        // Already gone.
      }
      // A provider may throw synchronously here, and stopping is best-effort.
      try {
        void Promise.resolve(stale.waitForExit?.()).catch(() => {})
      } catch {
        // Nothing left to observe.
      }
    }
    return display
  }

  const startOnce = async () => {
    if (terminated) throw new Error('desktop-vnc: controller disposed')
    if (!enabled) throw new Error('desktop-vnc: disabled by configuration')

    // Reuse means "the server this controller started is still up", never "some
    // server answers this port": the latter is another instance's desktop.
    if (ownsLiveServer()) {
      note('info', `desktop-vnc: reusing the VNC server this instance started on 127.0.0.1:${port}`)
      return { running: true, port, started: false }
    }

    const allocated = await allocatePort()
    if (allocated === null) {
      const message = `没有空闲的 RFB 端口（127.0.0.1:${range.min}..:${range.max} 都被占用）`
      note('warn', `desktop-vnc: ${message}`)
      return { running: false, port: candidates[0], started: false, error: message }
    }
    port = allocated

    let executable = 'x11vnc'
    if (typeof resolveExecutable === 'function') {
      try {
        executable = await resolveExecutable('x11vnc')
      } catch (error) {
        const message = describeSpawnError(error, 'x11vnc')
        note('warn', `desktop-vnc: ${message}`)
        return { running: false, port, started: false, error: message }
      }
    }
    if (typeof spawn !== 'function') {
      const message = 'x11vnc spawn unavailable'
      return { running: false, port, started: false, error: message }
    }

    let started
    try {
      started = spawn({
        argv: x11vncArgv(executable, { display, port }),
        cwd,
        // The display's access control is on, so the RFB server presents the same
        // cookie the browser does. Without it x11vnc exits with
        // "Authorization required", and the panel's websocket gets a 503.
        ...(authority === null ? {} : { env: { DISPLAY: display, XAUTHORITY: authority } }),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: LOG_CAPTURE_BYTES },
          stderr: { maxBytes: LOG_CAPTURE_BYTES },
        },
        graceMs: 2000,
      })
    } catch (error) {
      const message = describeSpawnError(error, 'x11vnc')
      note('warn', `desktop-vnc: ${message}`)
      return { running: false, port, started: false, error: message }
    }

    handle = started
    displayFor = display
    exitInfo = null
    watch(started)

    if (await waitForBind(started, port)) {
      note('info', `desktop-vnc: started x11vnc on 127.0.0.1:${port} (display ${display})`)
      return { running: true, port, started: true }
    }

    const message = exitReasonFor(started) ?? `x11vnc did not bind 127.0.0.1:${port} within ${startTimeoutMs}ms`
    note('warn', `desktop-vnc: ${message}`)
    // A process that never bound is useless and would keep the port occupied:
    // terminate exactly this child, then wait for it to actually go away.
    requestedStops.add(started)
    try {
      started.terminate?.()
      await Promise.resolve(started.waitForExit?.()).catch(() => {})
    } catch {
      // Best-effort teardown of a failed start.
    }
    if (handle === started) clearHandle()
    return { running: false, port, started: false, error: message }
  }

  const ensure = () => {
    if (starting !== null) return starting
    starting = startOnce().finally(() => {
      starting = null
    })
    return starting
  }

  const stop = async () => {
    const started = handle
    clearHandle()
    // The port is released with the server: the next ensure() allocates afresh
    // rather than reporting a port this instance no longer holds.
    port = null
    if (started === null) return
    requestedStops.add(started)
    try {
      started.terminate?.()
    } catch {
      // Already gone.
    }
    try {
      await Promise.resolve(started.waitForExit?.())
    } catch {
      // The provider can no longer observe the range; nothing left to do.
    }
  }

  return {
    ensure,
    stop,
    status,
    /** The display x11vnc currently mirrors (v2: the nested display). */
    display: () => display,
    setDisplay,
    setAuthority,
    /** Plugin unload: stop the one process this controller started. */
    dispose: async () => {
      terminated = true
      await stop()
    },
  }
}
