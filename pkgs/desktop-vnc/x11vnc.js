/**
 * desktop-vnc Host half — x11vnc process lifecycle.
 *
 * The panel is useless without a VNC server on `127.0.0.1:<rfbPort>`, so the
 * plugin starts and owns one: `ensure()` reuses whatever already listens on that
 * port and otherwise spawns `x11vnc` against the configured display. Two
 * properties are load-bearing:
 *
 * - **Never touch a process this controller did not start.** A port already in
 *   listening state means somebody else's VNC server (a system unit, an earlier
 *   `x11vnc` invocation) and it is reused verbatim; no `pkill`, no pattern
 *   matching, no second server fighting for the same port.
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
  let displayFor = null
  const port = normalizePort(config.rfbPort)
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

  /** Wait until the port answers, or give up and report why. */
  const waitForBind = async (started) => {
    const exited = hasExited(started)
    let done = false
    exited.then(() => {
      done = true
    })
    const deadline = Date.now() + startTimeoutMs
    for (;;) {
      if (await probe(port)) return true
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
    const result = { running: false, port }
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
  const setDisplay = (value) => {
    const next = normalizeDisplay(value, display)
    if (next === display) return display
    display = next
    if (handle !== null && displayFor !== null && displayFor !== next) {
      const stale = handle
      requestedStops.add(stale)
      clearHandle()
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

    // Somebody else already serves this port: reuse it and never adopt or kill it.
    if (await probe(port)) {
      note('info', `desktop-vnc: reusing the VNC server already listening on 127.0.0.1:${port}`)
      return { running: true, port, started: false }
    }

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

    if (await waitForBind(started)) {
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
    /** Plugin unload: stop the one process this controller started. */
    dispose: async () => {
      terminated = true
      await stop()
    },
  }
}
