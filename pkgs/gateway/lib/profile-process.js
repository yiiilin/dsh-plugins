/**
 * The local profile processes.
 *
 * A `local` environment is a profile this node runs itself: the daemon spawns one
 * `dsh` child per local environment and proxies `/<id>/` to its loopback port. That
 * makes a local profile behave like a remote one from the browser's side — same
 * prefix, same full interface — without a tunnel and without a second machine.
 *
 * Three decisions are load-bearing here:
 *
 * - **The child is spawned with this process's own `DSH_HOME` and cwd.** A profile
 *   that resolves its modules from a different home fails at boot in ways that look
 *   like a broken composition; `docs/changes/daemon-design.md` records a week lost to
 *   exactly that. The home is therefore inherited, never derived.
 * - **A port is claimed before it is bound, and probed before it is used.** Any
 *   listener already answering on a candidate belongs to somebody else and is skipped,
 *   never adopted — the same rule `browser-vnc` applies to its RFB range.
 * - **A crashing child is not restarted forever.** Three failures inside a minute mark
 *   the environment `failed` and leave it visible with the exit code and the tail of
 *   its stderr. A silent retry loop would burn CPU and hide the reason.
 *
 * @module @yiln-dsh/dsh-gateway/profile-process
 */

import { connect } from 'node:net'

/** How long a fresh child gets to print its launch URL before it counts as failed. */
const READY_TIMEOUT_MS = 60_000

/** Failures inside this window that mark an environment failed rather than restart. */
const FAILURE_WINDOW_MS = 60_000

/** Failures allowed inside {@link FAILURE_WINDOW_MS} before giving up. */
const FAILURE_LIMIT = 3

/** Bytes of child output kept for the failure report. */
const OUTPUT_TAIL_BYTES = 2_048

/** How long SIGTERM is given before SIGKILL. */
const STOP_GRACE_MS = 5_000

/**
 * Is something already listening on this port?
 *
 * A plain TCP probe: any listener means the port is taken, so the pool walk skips it
 * rather than letting a child fail to bind.
 *
 * @param {number} port the port to test.
 * @param {number} [timeoutMs] how long to wait for an answer.
 * @returns {Promise<boolean>} true when a listener answers.
 */
export function defaultPortProbe(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Extract the launch URL a `dsh web` child prints on stdout.
 *
 * The child prints exactly one line, `dsh web: http://127.0.0.1:<port>/?token=…`. The
 * token is what the daemon exchanges for a session cookie, so it has to be read from
 * the child rather than assumed.
 *
 * @param {string} text accumulated stdout.
 * @returns {{ url: string, token: string } | undefined}
 */
export function parseLaunchLine(text) {
  const match = /dsh web:\s+(https?:\/\/\S+)/u.exec(text)
  if (match === null) return undefined
  const url = match[1]
  const token = /[?&]token=([^&\s]+)/u.exec(url)?.[1]
  if (token === undefined || token === '') return undefined
  return { url, token }
}

/**
 * Read a process's resident set size, or undefined when it is gone.
 *
 * `/proc/<pid>/status` is Linux-only. Every other platform simply reports nothing
 * rather than a fabricated number, so the panel shows a blank cell instead of a lie.
 *
 * @param {number} pid
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<number | undefined>} bytes
 */
export async function readRss(pid, readFile) {
  try {
    const text = await readFile(`/proc/${String(pid)}/status`)
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(text)
    if (match === null) return undefined
    return Number(match[1]) * 1024
  } catch {
    return undefined
  }
}

/**
 * The table of local profile children.
 *
 * Every dependency that touches the outside world is injectable, so the lifecycle
 * rules are testable without spawning a real `dsh`.
 *
 * @param {object} options
 * @param {(spec: { profile: string, port: number }) => import('node:child_process').ChildProcess} options.spawn
 * @param {string} options.execPath node binary the unit would use.
 * @param {string} options.script the dsh entry script (`process.argv[1]`).
 * @param {string} options.dshHome inherited verbatim.
 * @param {string} options.cwd inherited verbatim.
 * @param {number[]} options.portRange `[low, high]` inclusive pool.
 * @param {(port: number) => Promise<boolean>} [options.probe]
 * @param {(path: string) => Promise<string>} [options.readFile]
 * @param {() => number} [options.now]
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.warn]
 * @returns the table.
 */
export function createProfileProcesses({
  spawn,
  execPath,
  script,
  dshHome,
  cwd,
  portRange,
  probe = defaultPortProbe,
  readFile,
  now = Date.now,
  log = () => {},
  warn = () => {},
}) {
  /** profile -> record */
  const records = new Map()
  /** port -> profile, claimed for the lifetime of the table. */
  const claimed = new Map()

  /** @returns {{ low: number, high: number }} */
  function bounds() {
    const [low, high] = portRange
    if (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > 65_535 || low > high) {
      throw new Error(`daemon: localProfilePortRange must be [low, high] within 1-65535, got ${JSON.stringify(portRange)}`)
    }
    return { low, high }
  }

  /**
   * Claim the lowest port in the pool that nobody answers on and no other local
   * environment holds.
   *
   * @param {number} [preferred] a port already recorded for this environment.
   * @returns {Promise<number>}
   */
  async function claimPort(preferred) {
    const { low, high } = bounds()
    if (preferred !== undefined) {
      // A recorded port is honoured unless a foreign listener took it meanwhile.
      if (!claimed.has(preferred) && !(await probe(preferred))) {
        claimed.set(preferred, '')
        return preferred
      }
    }
    for (let port = low; port <= high; port += 1) {
      if (claimed.has(port)) continue
      if (await probe(port)) continue
      claimed.set(port, '')
      return port
    }
    throw new Error(`daemon: no free port in localProfilePortRange ${low}-${high}`)
  }

  /** The record for one profile, created on first use. */
  function recordOf(profile, port) {
    let record = records.get(profile)
    if (record === undefined) {
      record = {
        profile,
        port,
        child: undefined,
        state: 'stopped',
        /** Accumulated stdout, searched for the launch line. */
        stdout: '',
        /** Tail of stderr, kept for the failure report. */
        stderr: '',
        /** Launch token, cleared on every start. */
        token: undefined,
        /** Loopback URL the child printed. */
        url: undefined,
        /** Resolves once the launch line arrives, rejects on failure or timeout. */
        ready: undefined,
        /** Timestamps of recent unexpected exits. */
        failures: [],
        exitCode: undefined,
        error: undefined,
      }
      records.set(profile, record)
    }
    return record
  }

  /** Trim a buffer to its last {@link OUTPUT_TAIL_BYTES}. */
  function tail(text) {
    return text.length <= OUTPUT_TAIL_BYTES ? text : text.slice(-OUTPUT_TAIL_BYTES)
  }

  /**
   * Spawn one profile if it is not already running, and wait until it prints its
   * launch URL.
   *
   * @param {string} profile
   * @param {number} [preferredPort] the port recorded for this environment.
   * @returns {Promise<{ profile: string, port: number, url: string, token: string }>}
   */
  async function ensure(profile, preferredPort) {
    const existing = records.get(profile)
    if (existing?.state === 'running') {
      return { profile, port: existing.port, url: existing.url, token: existing.token }
    }
    if (existing?.state === 'starting') return await existing.ready

    // Reserve the record BEFORE the first await. Claiming a port is asynchronous, and
    // without the reservation two concurrent `ensure` calls both pass the checks above,
    // both claim a port and both spawn — two processes for one profile, which splits
    // one session registry across two listeners. The reservation is what makes the
    // "one process per profile" rule hold under concurrency, not the state check.
    const record = recordOf(profile, existing?.port ?? 0)
    let settle
    record.ready = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    // A rejected `ready` that nobody awaits (a profile stopped before it booted) must
    // not surface as an unhandled rejection.
    record.ready.catch(() => {})
    record.state = 'starting'
    record.stdout = ''
    record.stderr = ''
    record.token = undefined
    record.url = undefined
    record.exitCode = undefined
    record.error = undefined

    let port
    try {
      port = existing?.port ?? (await claimPort(preferredPort))
    } catch (error) {
      record.state = 'failed'
      record.error = String(error?.message ?? error)
      settle.reject(new Error(record.error))
      return await record.ready
    }
    // The reservation made this record visible; a concurrent caller may have read it
    // before the port was known, so the port is published here.
    record.port = port
    claimed.set(port, profile)

    const args = [script, '--profile', profile, '--no-open', '--port', String(port)]
    let child
    try {
      child = spawn({
        profile,
        port,
        command: execPath,
        args,
        // Inherited verbatim: a child resolving modules from another home boots into a
        // composition that cannot find its own packages.
        env: { ...process.env, DSH_HOME: dshHome },
        cwd,
      })
    } catch (error) {
      record.state = 'failed'
      record.error = `could not spawn: ${String(error?.message ?? error)}`
      claimed.delete(port)
      settle.reject(new Error(record.error))
      return await record.ready
    }
    record.child = child

    const timer = setTimeout(() => {
      if (record.state !== 'starting') return
      record.state = 'failed'
      record.error = `no launch URL within ${String(READY_TIMEOUT_MS / 1000)}s`
      warn(`daemon: profile ${profile} did not report a launch URL; see its stderr`)
      try { child.kill('SIGTERM') } catch {}
      settle.reject(new Error(record.error))
    }, READY_TIMEOUT_MS)
    timer.unref?.()

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => {
      record.stdout = tail(record.stdout + String(chunk))
      if (record.state !== 'starting') return
      const launch = parseLaunchLine(record.stdout)
      if (launch === undefined) return
      record.url = launch.url
      record.token = launch.token
      record.state = 'running'
      clearTimeout(timer)
      log(`daemon: profile ${profile} listening on 127.0.0.1:${String(port)}`)
      settle.resolve({ profile, port, url: record.url, token: record.token })
    })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => {
      record.stderr = tail(record.stderr + String(chunk))
    })

    child.once?.('error', (error) => {
      record.state = 'failed'
      record.error = String(error?.message ?? error)
      clearTimeout(timer)
      settle.reject(new Error(record.error))
    })

    child.once?.('exit', (code, signal) => {
      record.child = undefined
      record.exitCode = code ?? undefined
      clearTimeout(timer)
      // A deliberate stop already moved the state; do not overwrite it.
      if (record.state === 'stopped') return
      if (record.state === 'starting') {
        record.state = 'failed'
        record.error = `exited before reporting a launch URL (code ${String(code)}, signal ${String(signal)})`
        settle.reject(new Error(record.error))
        return
      }
      const at = now()
      record.failures = record.failures.filter((entry) => at - entry < FAILURE_WINDOW_MS)
      record.failures.push(at)
      if (record.failures.length >= FAILURE_LIMIT) {
        record.state = 'failed'
        record.error = `exited ${String(record.failures.length)} times within ${String(FAILURE_WINDOW_MS / 1000)}s (last code ${String(code)})`
        warn(`daemon: profile ${profile} is failing repeatedly; not restarting it`)
        return
      }
      record.state = 'stopped'
      record.error = `exited (code ${String(code)}, signal ${String(signal)})`
    })

    return await record.ready
  }

  /**
   * Stop one profile and release its port.
   *
   * SIGTERM first, SIGKILL after {@link STOP_GRACE_MS}: a child that ignores the
   * polite signal must not keep the port for the rest of the daemon's life.
   *
   * @param {string} profile
   * @returns {Promise<void>}
   */
  async function stop(profile) {
    const record = records.get(profile)
    if (record === undefined) return
    const child = record.child
    record.state = 'stopped'
    record.token = undefined
    record.url = undefined
    if (child === undefined) {
      record.state = 'stopped'
      return
    }
    record.child = undefined
    const exited = new Promise((resolve) => {
      child.once?.('exit', () => resolve())
      // A child that never emits `exit` (already gone) must not hang the caller.
      setTimeout(resolve, STOP_GRACE_MS).unref?.()
    })
    try { child.kill('SIGTERM') } catch {}
    await exited
    if (record.state === 'stopped' && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch {}
    }
    if (record.port !== undefined) claimed.delete(record.port)
  }

  /** Stop every child. Called when the daemon unloads, so none outlives it. */
  async function stopAll() {
    await Promise.all([...records.keys()].map((profile) => stop(profile)))
  }

  /**
   * One environment's state, for the panel and the router.
   *
   * @param {string} profile
   * @param {(path: string) => Promise<string>} [reader]
   * @returns {Promise<{ state: string, port?: number, pid?: number, rssBytes?: number, error?: string, exitCode?: number, stderrTail?: string }>}
   */
  async function status(profile, reader) {
    const record = records.get(profile)
    if (record === undefined) return { state: 'stopped' }
    const pid = record.child?.pid
    const answer = { state: record.state }
    if (record.port !== undefined) answer.port = record.port
    if (pid !== undefined) answer.pid = pid
    if (record.error !== undefined) answer.error = record.error
    if (record.exitCode !== undefined) answer.exitCode = record.exitCode
    if (record.state === 'failed' && record.stderr !== '') answer.stderrTail = record.stderr
    if (pid !== undefined && reader !== undefined) {
      const rss = await readRss(pid, reader)
      if (rss !== undefined) answer.rssBytes = rss
    }
    return answer
  }

  return { ensure, stop, stopAll, status, claimPort, bounds, records }
}
