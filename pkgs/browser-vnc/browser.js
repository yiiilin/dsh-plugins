/**
 * desktop-vnc Host half — the Xephyr + Chromium browser stack.
 *
 * v2 turns the panel into a *browser* instead of a mirror of the whole Xfce
 * desktop. One nested X server owns a real window on the host display, one
 * Chromium renders the page inside it, and x11vnc mirrors the nested display:
 *
 *     :0  host desktop
 *      └─ Xephyr window "DSH Desktop Browser"  (nested display :N, on :0)
 *          └─ Chromium                          (the instance the panel shows)
 *
 * Three properties are load-bearing:
 *
 * - **The nested server is a window, not a headless framebuffer.** Xephyr is
 *   spawned with an explicit `DISPLAY=<host>` (it refuses to start without one)
 *   so its window lands on the real desktop. Xvfb is only a fail-soft fallback
 *   that keeps the panel useful when Xephyr is absent; it is reported honestly
 *   as `desktopVisible: false`.
 * - **Never touch a process this stack did not start.** Only the pids of the
 *   children this controller spawned are signalled, and only by pid — never by
 *   name — so a user's own Xephyr or Chromium is out of reach.
 * - **One start under concurrency.** The sidebar can mount, remount and open
 *   two tabs while the first `ensure()` is still waiting for the nested display
 *   socket, so the in-flight promise is shared instead of starting a second
 *   Xephyr or Chromium.
 *
 * `spawn`, `resolveExecutable`, `probe`, `kill` and `removeDir` are injected so
 * unit tests never start a real process or touch the real filesystem.
 *
 * @module @yiln-dsh/dsh-browser-vnc/browser
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { INSTANCE_DIR_PREFIX } from './instance-dirs.js'
import { describeSpawnError } from './x11vnc.js'

/** `FamilyLocal` in an Xauthority record; the only field stored little-endian. */
const FAMILY_LOCAL = 1

/** The nested X server that puts a real, desktop-visible window on `:0`. */
export const XEPHYR_EXECUTABLE = 'Xephyr'
/** Headless fallback used only when Xephyr cannot be started at all. */
export const XVFB_EXECUTABLE = 'Xvfb'
/**
 * Low end of the nested display range this stack claims.
 *
 * High on purpose. `:90` and its neighbours are where headless test tooling
 * conventionally starts its own X servers, so a panel that took the first free
 * number there shared a display with whatever else on the machine wanted one —
 * and, because access control used to be off, anything could draw onto the view
 * the panel mirrors. Starting well above that range keeps this display ours.
 */
export const NESTED_DISPLAY_MIN = 200
/**
 * High end of the nested display range this stack claims.
 *
 * Wide on purpose: one process now opens browser instances for as long as it
 * runs, so the pool must not impose an artificial ceiling. With a per-instance
 * RFB port range of 100 addresses the port range is the tighter limit; this
 * number only has to stay above it.
 */
export const NESTED_DISPLAY_MAX = 999
/** Default window title, also the human handle for the window on the desktop. */
export const DEFAULT_WINDOW_TITLE = 'DSH Desktop Browser'
/** Chromium's default landing page when the config leaves `startUrl` empty. */
export const DEFAULT_START_URL = 'about:blank'

/** How long a freshly spawned server gets to publish its display socket. */
const DEFAULT_START_TIMEOUT_MS = 4000
/** Interval between display probes while waiting for the socket. */
const DEFAULT_PROBE_INTERVAL_MS = 120
/** Window a freshly spawned Chromium gets to survive before it counts as started. */
const DEFAULT_SETTLE_MS = 250
/** TERM-to-KILL grace for a child this stack owns. */
const DEFAULT_GRACE_MS = 2000
/** Collected stdout/stderr cap; Chromium's chatter is never surfaced raw. */
const LOG_CAPTURE_BYTES = 16 * 1024

/**
 * Normalize an X display spelling (`:96`, `96`, `:96.0`) to `:96`.
 * @param {unknown} value candidate display.
 * @returns {string|null} the normalized display, or null when unusable.
 */
export function parseDisplay(value) {
  if (typeof value !== 'string') return null
  const match = /^:?([0-9]{1,3})(?:\.[0-9]{1,3})?$/.exec(value.trim())
  if (match === null) return null
  const number = Number(match[1])
  return Number.isInteger(number) && number >= 0 && number <= 999 ? `:${number}` : null
}

/** The numeric display number of `display`, or null when it is not a display. */
export function displayNumber(display) {
  const normalized = parseDisplay(display)
  return normalized === null ? null : Number(normalized.slice(1))
}

/** The X lock file a display would own, or null for an unusable display. */
export function lockPathFor(display) {
  const number = displayNumber(display)
  return number === null ? null : `/tmp/.X${number}-lock`
}

/** The unix socket a display publishes, or null for an unusable display. */
export function socketPathFor(display) {
  const number = displayNumber(display)
  return number === null ? null : `/tmp/.X11-unix/X${number}`
}

/**
 * Default occupancy/readiness probe: a display counts as taken once either its
 * lock file or its unix socket exists. It answers both questions the stack has
 * — "may I pick this number?" before a start and "is it up yet?" after one.
 * @param {string} display candidate display.
 * @returns {boolean} true when the display already exists.
 */
export function defaultProbe(display) {
  const socket = socketPathFor(display)
  const lock = lockPathFor(display)
  if (socket === null || lock === null) return false
  return existsSync(socket) || existsSync(lock)
}

/**
 * First display in `[min, max]` that no lock file and no socket claims.
 * @param {object} [options]
 * @param {(display: string) => boolean|Promise<boolean>} [options.probe] occupancy probe.
 * @param {number} [options.min] first candidate number.
 * @param {number} [options.max] last candidate number.
 * @returns {Promise<string|null>} the free display, or null when the range is full.
 */
export async function pickFreeDisplay({
  probe = defaultProbe,
  min = NESTED_DISPLAY_MIN,
  max = NESTED_DISPLAY_MAX,
} = {}) {
  const usable = typeof probe === 'function' ? probe : defaultProbe
  for (let number = min; number <= max; number += 1) {
    const display = `:${number}`
    let taken = false
    try {
      taken = (await usable(display)) === true
    } catch {
      // An unreadable probe is not proof of occupancy; the start attempt reports
      // the real failure instead of this one hiding it.
      taken = false
    }
    if (!taken) return display
  }
  return null
}

/**
 * Turn any spawn failure into one readable, non-stack line for the panel.
 *
 * Defined once in {@link ./x11vnc.js} and re-exported here: the browser stack and
 * the RFB controller report the same environment failures (a missing binary, a
 * lost execute bit), and two byte-identical copies had already drifted apart
 * once. Importers of this module keep working unchanged.
 */
export { describeSpawnError }

/**
 * Write an Xauthority file holding one cookie for one display.
 *
 * Xephyr reads this to decide which clients may open a window on its display, and
 * Chromium presents the same cookie through `XAUTHORITY`. The file is per stack,
 * written 0600, and removed with the profile directory, so it is not a shared
 * credential another process can read its way in with.
 *
 * The binary layout is the MIT-MAGIC-COOKIE-1 record: a big-endian length and
 * bytes for the address family (left empty, meaning "any"), then the display
 * number as text, then the name `MIT-MAGIC-COOKIE-1`, then the cookie itself.
 *
 * @param path - where to write the file.
 * @param display - the display number, without the colon.
 * @param cookie - 16 random bytes.
 * @returns the path, for the caller to pass to both children.
 */
export function writeXauthority(path, display, cookie, host = hostname()) {
  const field = (buffer) => {
    const length = Buffer.allocUnsafe(2)
    length.writeUInt16BE(buffer.length, 0)
    return Buffer.concat([length, buffer])
  }
  // The family is the one field `xauth` stores little-endian: `FamilyLocal` is 1,
  // written as `01 00`. Everything after it — and every length — is big-endian.
  const family = Buffer.allocUnsafe(2)
  family.writeUInt16LE(FAMILY_LOCAL, 0)
  const record = Buffer.concat([
    family,
    // The address is the host name, not empty: a blank address matches no host, so
    // the cookie would be written and then never accepted.
    field(Buffer.from(host, 'latin1')),
    field(Buffer.from(String(display), 'latin1')),
    field(Buffer.from('MIT-MAGIC-COOKIE-1', 'latin1')),
    field(cookie),
  ])
  writeFileSync(path, record, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

/**
 * The argv that makes `:N` a real, resizable window on the host desktop.
 * `DISPLAY` for the *host* desktop travels in the spawn spec's environment.
 */
export function xephyrArgv(executable, { display, width, height, title = DEFAULT_WINDOW_TITLE, authFile, origin } = {}) {
  // `-screen WxH+X+Y` places the *nested screen* at that offset on the host
  // desktop. That is the right layer to stagger windows at: two Xephyr windows
  // side by side are two visible browsers. Offsetting the Chromium inside them
  // instead pushes a full-size window off its own screen, which shows as a black
  // border with the page hanging off the corner.
  const geometry = typeof origin === 'string' && origin !== '' ? `${width}x${height}+${origin}` : `${width}x${height}`
  return [
    executable,
    display,
    '-screen', `${geometry}x24`,
    // Access control stays ON and is narrowed to this stack's own cookie. The
    // display is a general-purpose one that other tools on this machine also
    // start things on, so `-ac` let any local process draw onto what the panel
    // mirrors — which is how an unrelated RDP client took over the view once.
    ...(authFile === undefined ? [] : ['-auth', authFile]),
    '-br',
    '-noreset',
    '-title', title,
    '-resizeable',
  ]
}

/** The argv for the headless fallback; Xvfb has no window and no title. */
export function xvfbArgv(executable, { display, width, height, authFile } = {}) {
  return [
    executable,
    display,
    '-screen', `${width}x${height}x24`,
    ...(authFile === undefined ? [] : ['-auth', authFile]),
    '-br',
    '-noreset',
    '-nolisten', 'tcp',
  ]
}

/**
 * The argv that renders the page inside the nested display. The user-data-dir
 * is per instance so this Chromium can never collide with the user's own
 * profile or with a second DSH process.
 */
export function chromiumArgv(executable, {
  userDataDir,
  width,
  height,
  startUrl = DEFAULT_START_URL,
  extraArgs = [],
  debugPort = undefined,
  windowTitle = undefined,
  windowPosition = undefined,
} = {}) {
  return [
    executable,
    '--no-sandbox',
    // Suppresses the "unsupported command-line flag: --no-sandbox" infobar that
    // Chromium otherwise draws across the top of the page. The panel mirrors
    // this window, so that bar would be permanent user-visible clutter.
    '--test-type',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-crash-restore-bubble',
    // Every instance gets its own position: two windows stacked at 0,0 look like
    // one browser, and the one underneath can never be brought forward by hand.
    `--window-position=${windowPosition ?? '0,0'}`,
    `--window-size=${width},${height}`,
    // A titled window is the only handle a person or a tool has on the desktop
    // window itself: the instance id is invisible in the UI otherwise, and every
    // window would carry the same title. `--window-name` (not `--app-window-title`,
    // which only applies to `--app` windows) is what actually renames the title.
    ...(typeof windowTitle === 'string' && windowTitle !== '' ? [`--window-name=${windowTitle}`] : []),
    // The debug port is what lets an agent act on *this* browser rather than on
    // whichever one it happened to launch: without it the instance id names a
    // window nothing can drive, and a model falls back to its own browser.
    ...(Number.isInteger(debugPort) && debugPort > 0 ? [`--remote-debugging-port=${debugPort}`] : []),
    ...extraArgs,
    startUrl === '' ? DEFAULT_START_URL : startUrl,
  ]
}

/** One readable line for an Xephyr fallback, kept honest about desktop visibility. */
export function describeFallback(reason) {
  return `Xephyr 不可用，已退回 Xvfb（桌面不可见）：${reason}`
}

/** A non-empty string, or the fallback. */
function textOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** A finite positive dimension, or the fallback. */
function sizeOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

/** Normalize the `browser` sub-config without losing any default. */
function normalizeBrowser(config) {
  const raw = config?.browser !== undefined && config.browser !== null && typeof config.browser === 'object'
    ? config.browser
    : {}
  return {
    enabled: raw.enabled !== false,
    executable: textOr(raw.executable, 'chromium'),
    nestedDisplay: textOr(raw.nestedDisplay, 'auto'),
    windowTitle: textOr(raw.windowTitle, DEFAULT_WINDOW_TITLE),
    // Optional per-instance identity: the CDP port an agent drives this browser
    // through, the title a person reads on the desktop, and where it lands.
    debugPort: Number.isInteger(raw.debugPort) && raw.debugPort > 0 ? raw.debugPort : undefined,
    windowPosition: typeof raw.windowPosition === 'string' && raw.windowPosition !== '' ? raw.windowPosition : undefined,
    // Where the nested Xephyr screen sits on the host desktop; empty means 0,0.
    screenOrigin: typeof raw.screenOrigin === 'string' && raw.screenOrigin !== '' ? raw.screenOrigin : undefined,
    startUrl: textOr(raw.startUrl, DEFAULT_START_URL),
    extraArgs: Array.isArray(raw.extraArgs)
      ? raw.extraArgs.filter((arg) => typeof arg === 'string' && arg !== '')
      : [],
  }
}

/** Send `signal` to one owned pid; never throws (delivery races process exit). */
function defaultKill(pid, signal) {
  process.kill(pid, signal)
}

/** Remove the per-instance Chromium profile this stack created. */
function defaultRemoveDir(dir) {
  return rm(dir, { recursive: true, force: true })
}

/** Resolve after `ms`; every use is bounded by a start timeout or a grace period. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Resolve `true` when `entry` reports an outcome first, `false` when `ms`
 * elapses first. The timer is cleared on the winning exit so a fast, clean
 * teardown never waits out the whole grace period.
 */
function raceExit(entry, ms) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    Promise.resolve(entry?.handle?.done).then(() => finish(true), () => finish(true))
  })
}

/**
 * Build the browser stack.
 *
 * `ensure()` never rejects for an environment problem: it answers with an
 * `ok`/`browser` verdict plus a readable `error`, so the WS upgrade can turn it
 * into a 503 that explains itself.
 *
 * **Reading the result**: gate on `ok === true` (or `browser === true` for
 * "Chromium is rendering"), *not* on the presence of `error`. The Xephyr →
 * Xvfb fallback is a usable stack, so it returns `ok: true`, `browser: true`
 * and still carries the readable Xephyr reason in `error` (per contract §5)
 * and mirrored in `warning`/`degraded`/`desktopVisible: false`.
 *
 * @param {object} options
 * @param {(spec: object) => object} options.spawn starts a child and returns a live handle (`done`/`terminate`/`waitForExit`).
 * @param {() => Promise<string>} [options.resolveExecutable] resolves a binary path, rejecting when absent.
 * @param {object} [options.config] plugin Config (`display`, viewport, `browser`).
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @param {(display: string) => boolean|Promise<boolean>} [options.probe] display occupancy/readiness probe, for tests.
 * @param {(pid: number, signal: string) => void} [options.kill] signal sink, for tests.
 * @param {(dir: string) => Promise<void>} [options.removeDir] profile-dir removal, for tests.
 * @param {string} [options.tmpDir] base for the per-instance profile dir.
 * @param {string} [options.instanceKey] identity embedded in the profile dir name;
 *   defaults to `String(process.pid)`, which is only safe for a process that opens
 *   one stack — the plugin always passes a per-instance key.
 * @param {number} [options.pid] legacy alias: the instance id embedded in the
 *   profile dir (defaults to this process). Kept for the v1-shaped tests.
 * @param {number} [options.startTimeoutMs] budget for the nested display socket.
 * @param {number} [options.probeIntervalMs] probe cadence while waiting.
 * @param {number} [options.settleMs] window a new Chromium must survive.
 * @param {number} [options.graceMs] TERM-to-KILL grace for owned children.
 * @returns {{ensure: () => Promise<object>, stop: () => Promise<void>, status: () => object, dispose: () => Promise<void>}} stack.
 */
export function createBrowserStack({
  spawn,
  resolveExecutable,
  config = {},
  log,
  probe = defaultProbe,
  kill = defaultKill,
  removeDir = defaultRemoveDir,
  tmpDir,
  instanceKey,
  pid,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  graceMs = DEFAULT_GRACE_MS,
} = {}) {
  const hostDisplay = parseDisplay(config.display) ?? ':0'
  const browserConfig = normalizeBrowser(config)
  const width = sizeOr(config.viewportWidth, 1280)
  const height = sizeOr(config.viewportHeight, 800)
  const cwd = textOr(config.cwd, tmpdir())
  const baseDir = textOr(tmpDir, tmpdir())
  // The identity embedded in the directory name. A bare sequence restarts at 1 in
  // every process and would reuse a crashed process's profile (inheriting its
  // SingletonLock and stale Xauthority); a bare pid collides when the pid is
  // recycled. Production passes `<pid>-<bootId>-<seq>` from {@link ./instance-dirs.js};
  // the `pid` option stays as a simple identity for callers that only need two
  // stacks told apart.
  const key = textOr(instanceKey, Number.isInteger(pid) && pid >= 0 ? String(pid) : String(process.pid))
  // One directory per browser instance, holding both the Chromium profile and the
  // Xauthority cookie this display trusts. Two instances in one process therefore
  // never share a SingletonLock and never overwrite each other's cookie.
  const instanceDir = join(baseDir, `${INSTANCE_DIR_PREFIX}${key}`)
  const probeDisplay = typeof probe === 'function' ? probe : defaultProbe

  /**
   * @type {{
   *   display: string|null, mode: 'xephyr'|'xvfb'|null, desktopVisible: boolean,
   *   server: object|null, browser: object|null, profileDir: string|null,
   *   fallbackReason: string|null,
   * }}
   */
  const state = {
    display: null,
    mode: null,
    desktopVisible: false,
    server: null,
    browser: null,
    profileDir: null,
    // The Xauthority this stack's display trusts; shared by the server and the
    // browser, and removed with the instance directory.
    authFile: null,
    fallbackReason: null,
  }

  /** @type {Promise<object>|null} in-flight ensure(), shared by concurrent callers. */
  let starting = null
  let terminated = false

  const note = (level, message) => {
    if (typeof log === 'function') {
      try {
        log(level, message)
      } catch {
        // Diagnostics must never break the lifecycle.
      }
    }
  }

  /** Collected stderr text of a handle, trimmed to one diagnostic line. */
  const collectedText = (entry, stream) => {
    const reader = entry?.handle?.collected?.[stream]
    if (reader === undefined || reader === null) return ''
    try {
      return reader.readFrom(0).text.trim()
    } catch {
      return ''
    }
  }

  /**
   * Record one freshly spawned child: its pid, and a watcher that flips
   * `exited` once so liveness is answered from state instead of by probing.
   */
  const track = (handle, kind) => {
    const entry = {
      kind,
      handle,
      pid: typeof handle?.pid === 'number' ? handle.pid : null,
      exited: false,
      reason: null,
      requested: false,
    }
    const settled = Promise.resolve(handle?.done).then(
      (result) => {
        const code = result?.exitCode
        entry.reason = code === null || code === undefined ? `${kind} exited` : `${kind} exited with code ${code}`
        entry.exited = true
        return entry.reason
      },
      (error) => {
        entry.reason = describeSpawnError(error, kind)
        entry.exited = true
        return entry.reason
      },
    )
    settled.then((reason) => {
      const stderr = collectedText(entry, 'stderr')
      // A stop we asked for is the expected outcome, not a failure to report.
      if (entry.requested) note('info', `desktop-vnc: ${reason} (requested)`)
      else if (stderr !== '') note('warn', `desktop-vnc: ${reason}: ${stderr.split('\n')[0]}`)
      else note('warn', `desktop-vnc: ${reason}`)
    }).catch(() => {})
    return entry
  }

  const alive = (entry) => entry !== null && entry !== undefined && entry.exited !== true

  /** Signal exactly the pid we recorded, never a name and never a foreign pid. */
  const signalEntry = (entry, signal) => {
    if (entry === null || entry.pid === null) return
    try {
      kill(entry.pid, signal)
    } catch {
      // The pid may already be gone; that is the normal case for SIGKILL.
    }
  }

  /** TERM, then wait at most `graceMs` before KILL: the contract's ladder. */
  const endEntry = async (entry) => {
    if (entry === null || entry === undefined || entry.exited === true) return
    entry.requested = true
    signalEntry(entry, 'SIGTERM')
    try {
      entry.handle?.terminate?.()
    } catch {
      // Already gone.
    }
    const exited = await raceExit(entry, graceMs)
    if (exited === true || entry.exited === true) return
    signalEntry(entry, 'SIGKILL')
  }

  /** Spawn spec shared by all three children: collect stdio, never inherit. */
  const spawnSpec = (argv, env) => ({
    argv,
    cwd,
    ...(env === undefined ? {} : { env }),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: LOG_CAPTURE_BYTES },
      stderr: { maxBytes: LOG_CAPTURE_BYTES },
    },
    graceMs,
  })

  /** Resolve one binary, or report a readable reason without spawning. */
  const resolveCommand = async (command) => {
    if (typeof resolveExecutable !== 'function') return { executable: command }
    try {
      const resolved = await resolveExecutable(command)
      return { executable: textOr(resolved, command) }
    } catch (error) {
      return { executable: command, error: describeSpawnError(error, command) }
    }
  }

  /** Wait until the nested display answers the same probe auto-pick used. */
  const waitForDisplay = async (entry) => {
    const deadline = Date.now() + startTimeoutMs
    for (;;) {
      let ready = false
      try {
        ready = (await probeDisplay(state.display)) === true
      } catch {
        ready = false
      }
      if (ready) return true
      if (entry.exited === true) return false
      if (Date.now() >= deadline) return false
      await delay(probeIntervalMs)
    }
  }

  /** Xephyr on the host display: the only mode where the browser is desktop-visible. */
  const tryStartXephyr = async () => {
    if (typeof spawn !== 'function') return { ok: false, error: 'subprocess service unavailable' }
    const resolved = await resolveCommand(XEPHYR_EXECUTABLE)
    if (resolved.error !== undefined) return { ok: false, error: resolved.error }

    let handle
    try {
      handle = spawn(spawnSpec(
        xephyrArgv(resolved.executable, {
          display: state.display,
          width,
          height,
          title: browserConfig.windowTitle,
          authFile: state.authFile ?? undefined,
          origin: browserConfig.screenOrigin,
        }),
        { DISPLAY: hostDisplay },
      ))
    } catch (error) {
      return { ok: false, error: describeSpawnError(error, XEPHYR_EXECUTABLE) }
    }

    const entry = track(handle, XEPHYR_EXECUTABLE)
    if (await waitForDisplay(entry)) return { ok: true, entry }

    const reason = entry.reason
      ?? `Xephyr 未在 ${startTimeoutMs}ms 内就绪（display ${state.display}）`
    await endEntry(entry)
    return { ok: false, error: reason }
  }

  /** Headless fallback on the same display; never desktop-visible. */
  const startXvfb = async () => {
    if (typeof spawn !== 'function') return { ok: false, error: 'subprocess service unavailable' }
    const resolved = await resolveCommand(XVFB_EXECUTABLE)
    if (resolved.error !== undefined) return { ok: false, error: resolved.error }

    let handle
    try {
      handle = spawn(spawnSpec(xvfbArgv(resolved.executable, {
        display: state.display,
        width,
        height,
        authFile: state.authFile ?? undefined,
      })))
    } catch (error) {
      return { ok: false, error: describeSpawnError(error, XVFB_EXECUTABLE) }
    }

    const entry = track(handle, XVFB_EXECUTABLE)
    if (await waitForDisplay(entry)) return { ok: true, entry }

    const reason = entry.reason
      ?? `Xvfb 未在 ${startTimeoutMs}ms 内就绪（display ${state.display}）`
    await endEntry(entry)
    return { ok: false, error: reason }
  }

  /**
   * Start the nested server, preferring Xephyr. Any Xephyr failure — absent
   * binary, refused host display, no socket in time — degrades to Xvfb so the
   * panel still shows the browser; the reason travels in `error`.
   */
  const startServer = async () => {
    const xephyr = await tryStartXephyr()
    if (xephyr.ok === true) {
      state.mode = 'xephyr'
      state.server = xephyr.entry
      state.desktopVisible = true
      state.fallbackReason = null
      note('info', `desktop-vnc: started Xephyr on ${state.display} (host display ${hostDisplay})`)
      return { started: true }
    }

    note('warn', `desktop-vnc: Xephyr unavailable on ${state.display}: ${xephyr.error}`)
    const xvfb = await startXvfb()
    if (xvfb.ok !== true) {
      return {
        started: false,
        degraded: false,
        error: `${xephyr.error}；Xvfb 也不可用：${xvfb.error}`,
      }
    }

    state.mode = 'xvfb'
    state.server = xvfb.entry
    state.desktopVisible = false
    state.fallbackReason = describeFallback(xephyr.error)
    note('warn', `desktop-vnc: ${state.fallbackReason}`)
    return { started: true, degraded: true, error: state.fallbackReason }
  }

  /** Start the single Chromium instance inside whichever display is up. */
  const startChromium = async () => {
    if (typeof spawn !== 'function') return { error: 'subprocess service unavailable' }
    const resolved = await resolveCommand(browserConfig.executable)
    if (resolved.error !== undefined) return { error: resolved.error }

    // One profile per plugin instance: nothing here can read or lock the user's
    // own Chromium profile, and stop() removes exactly this directory.
    const profileDir = join(instanceDir, 'profile')
    state.profileDir = profileDir

    let handle
    try {
      handle = spawn(spawnSpec(
        chromiumArgv(resolved.executable, {
          userDataDir: profileDir,
          width,
          height,
          startUrl: browserConfig.startUrl,
          extraArgs: browserConfig.extraArgs,
          debugPort: browserConfig.debugPort,
          windowTitle: browserConfig.windowTitle,
          windowPosition: browserConfig.windowPosition,
        }),
        {
          DISPLAY: state.display,
          ...(state.authFile === null ? {} : { XAUTHORITY: state.authFile }),
        },
      ))
    } catch (error) {
      return { error: describeSpawnError(error, resolved.executable) }
    }

    const entry = track(handle, 'chromium')
    state.browser = entry

    // A Chromium that dies during startup (bad flag, broken profile) must not be
    // reported as a working panel.
    if (settleMs > 0) await raceExit(entry, settleMs)
    else await Promise.resolve()
    if (entry.exited === true) {
      state.browser = null
      return { error: entry.reason ?? 'chromium exited during startup' }
    }

    note('info', `desktop-vnc: started chromium on ${state.display}`)
    return { started: true }
  }

  /** Both the server entry and the browser entry are still alive. */
  const reusable = () => (
    state.display !== null
    && state.server !== null
    && alive(state.server)
    && alive(state.browser)
  )

  /** The display the nested stack will own: explicit, or the first free number. */
  const chooseDisplay = async () => {
    if (browserConfig.nestedDisplay !== 'auto') {
      const explicit = parseDisplay(browserConfig.nestedDisplay)
      if (explicit !== null) return explicit
      note('warn', `desktop-vnc: nestedDisplay "${browserConfig.nestedDisplay}" is not a display; using auto`)
    }
    return pickFreeDisplay({ probe: probeDisplay })
  }

  /** The public answer shape; `ok` is the single field the WS path should gate on. */
  const snapshot = ({ startedXephyr = false, startedChromium = false, error, disabled = false } = {}) => {
    const chromiumRunning = alive(state.browser)
    const xephyrRunning = state.mode === 'xephyr' && alive(state.server)
    const result = {
      display: state.display ?? hostDisplay,
      started: { xephyr: startedXephyr, chromium: startedChromium },
      browser: chromiumRunning,
      xephyr: xephyrRunning,
      chromium: chromiumRunning,
      mode: disabled ? 'disabled' : (state.mode ?? 'none'),
      desktopVisible: xephyrRunning && state.desktopVisible,
      degraded: state.mode === 'xvfb',
      fallback: state.mode === 'xvfb' ? XVFB_EXECUTABLE : null,
      profileDir: state.profileDir,
      // The cookie this display trusts. Anything else that draws into it — the
      // screenshot tool, the RFB server — has to present it now that access
      // control is on.
      authority: state.authFile,
      ok: disabled ? true : chromiumRunning,
    }
    if (error !== undefined) result.error = error
    if (state.fallbackReason !== null) result.warning = state.fallbackReason
    return result
  }

  const startOnce = async () => {
    if (terminated) throw new Error('desktop-vnc: browser stack disposed')

    if (!browserConfig.enabled) {
      note('info', 'desktop-vnc: browser stack disabled; the panel mirrors the host display')
      return snapshot({ disabled: true })
    }

    // Reuse: a live nested display with a live Chromium needs no work at all.
    if (reusable()) return snapshot()

    if (state.display === null) {
      const display = await chooseDisplay()
      if (display === null) {
        const message = `没有空闲的嵌套显示号（:${NESTED_DISPLAY_MIN}..:${NESTED_DISPLAY_MAX} 都被占用）`
        note('warn', `desktop-vnc: ${message}`)
        return snapshot({ error: message })
      }
      state.display = display
    }

    // The cookie has to exist before the display starts: the server is told to
    // trust exactly this file, and the browser presents it. Both are per instance.
    if (state.authFile === null) {
      try {
        mkdirSync(instanceDir, { recursive: true, mode: 0o700 })
        state.authFile = writeXauthority(
          join(instanceDir, 'Xauthority'),
          String(state.display).replace(/^:/u, ''),
          randomBytes(16),
        )
      } catch (error) {
        const message = `无法创建 Xauthority（${error instanceof Error ? error.message : String(error)}）`
        note('warn', `desktop-vnc: ${message}`)
        return snapshot({ error: message })
      }
    }

    let startedXephyr = false
    if (!alive(state.server)) {
      const server = await startServer()
      startedXephyr = server.started === true && state.mode === 'xephyr'
      if (server.error !== undefined && server.degraded !== true) {
        return snapshot({ error: server.error })
      }
    }

    let startedChromium = false
    if (!alive(state.browser)) {
      const chromium = await startChromium()
      if (chromium.error !== undefined) {
        return snapshot({ startedXephyr, startedChromium: false, error: chromium.error })
      }
      startedChromium = chromium.started === true
    }

    return snapshot({
      startedXephyr,
      startedChromium,
      error: state.fallbackReason ?? undefined,
    })
  }

  const ensure = () => {
    if (starting !== null) return starting
    starting = startOnce().finally(() => {
      starting = null
    })
    return starting
  }

  /**
   * Terminate exactly the children this stack started, then drop their instance
   * directory — the profile *and* the Xauthority cookie, which would otherwise
   * outlive the display it authorizes.
   */
  const stop = async () => {
    const browser = state.browser
    const server = state.server
    // Only remove a directory this stack actually created something in.
    const createdDir = state.profileDir !== null || state.authFile !== null
    // Remember the display before clearing it: its lock file and socket are ours
    // to remove, and a stale lock makes `defaultProbe` treat the number as taken
    // forever, silently burning one number per crash.
    const ownedDisplay = state.display

    state.browser = null
    state.server = null
    state.profileDir = null
    state.display = null
    state.mode = null
    state.desktopVisible = false
    state.authFile = null
    state.fallbackReason = null

    // Chromium first: it must not outlive the display it draws into.
    await endEntry(browser)
    await endEntry(server)

    if (createdDir) {
      try {
        await removeDir(instanceDir)
      } catch {
        // Best-effort: a leftover temp directory must not fail unload.
      }
    }

    await releaseDisplayFiles(ownedDisplay)
  }

  /**
   * Remove the lock file and socket this stack's own X server left behind.
   *
   * Called only after the server has been ended, and only for the display this
   * stack started on — a display it never owned is left alone. Both removals are
   * best-effort: the number being reclaimed matters more than the failure of one
   * unlink, and an unlink that fails leaves the old behaviour (a skipped number).
   *
   * @param {string|null} display the display this stack was running on.
   */
  const releaseDisplayFiles = async (display) => {
    if (typeof display !== 'string') return
    for (const path of [lockPathFor(display), socketPathFor(display)]) {
      if (path === null) continue
      try {
        await rm(path, { force: true })
      } catch {
        // Best-effort: a number that stays claimed is worse than a loud failure
        // only in theory — this is exactly the case where staying quiet is right.
      }
    }
  }

  const status = () => {
    const chromiumRunning = alive(state.browser)
    const serverRunning = alive(state.server)
    const xephyrRunning = state.mode === 'xephyr' && serverRunning
    const pids = {}
    if (serverRunning && state.server.pid !== null) {
      pids[state.mode === 'xvfb' ? 'xvfb' : 'xephyr'] = state.server.pid
    }
    if (chromiumRunning && state.browser.pid !== null) pids.chromium = state.browser.pid

    return {
      display: state.display ?? hostDisplay,
      running: chromiumRunning,
      xephyr: xephyrRunning,
      chromium: chromiumRunning,
      desktopVisible: xephyrRunning && state.desktopVisible,
      mode: state.mode ?? 'none',
      enabled: browserConfig.enabled,
      degraded: state.mode === 'xvfb',
      ...(state.fallbackReason === null ? {} : { warning: state.fallbackReason }),
      // The cookie file this stack's display trusts. Anything that draws into the
      // nested screen (the paste injector, a screenshot tool) has to present it,
      // and the caller has no other way to learn the path.
      ...(state.authFile === null ? {} : { authority: state.authFile }),
      pids,
    }
  }

  return {
    ensure,
    stop,
    status,
    /** Plugin unload: stop the children this stack owns and refuse further work. */
    dispose: async () => {
      terminated = true
      await stop()
    },
  }
}
