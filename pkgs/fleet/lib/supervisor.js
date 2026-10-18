/**
 * Child-process supervisor for fleet boxes.
 *
 * Each box runs as its own `dsh --profile <name>` process. A box cannot share a
 * process with another, because the filesystem, subprocess and sandbox services
 * are process-wide singletons: one `ctx.fs` means one execution world, so two
 * machines cannot be reached from one Harness process.
 *
 * The supervisor owns process lifetime and nothing else. It never reads the
 * child's output as a protocol; it only waits for the listening port so a
 * readiness answer reflects a real listener.
 *
 * @module @yiln-dsh/dsh-fleet/supervisor
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'

/**
 * Probe whether something is listening on a loopback port.
 *
 * @param port - TCP port.
 * @param timeoutMs - how long to wait for the connect attempt.
 * @returns true when the connection is accepted.
 */
export function probePort(port, timeoutMs = 500) {
  return new Promise((done) => {
    const socket = connect(port, '127.0.0.1')
    const finish = (result) => {
      socket.destroy()
      done(result)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Wait until a port accepts connections or the deadline passes.
 *
 * @param port - TCP port.
 * @param deadlineMs - total wait in milliseconds.
 * @param intervalMs - delay between probes.
 * @returns true when the port came up.
 */
export async function waitForPort(port, deadlineMs, intervalMs = 250) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (await probePort(port)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Wait for the child's startup announcement.
 *
 * The listener accepts a connection a moment before the `dsh web: <url>` line
 * reaches our pipe, so a readiness check that returns on the port alone races
 * the line. The deadline is short: the URL is a convenience for an operator, and
 * a box that is genuinely listening must still be reported as started.
 *
 * @param readLog - returns the output collected so far.
 * @param deadlineMs - how long to look for the line.
 * @returns the announced URL, or undefined when it never appeared.
 */
async function waitForStartupLine(readLog, deadlineMs = 3000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const match = /dsh web: (\S+)/u.exec(readLog())
    if (match !== null) return match[1]
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

/**
 * Create the box supervisor.
 *
 * @param options - process settings.
 * @param options.binPath - the `dsh` executable.
 * @param options.profileDir - resolves a profile name to its directory.
 * @param options.homeDir - `$DSH_HOME` handed to every child.
 * @param options.readyMs - how long a started box may take to listen.
 * @param options.env - extra environment for children.
 * @param options.onExit - called with a box id when its process exits.
 * @param options.authority - external authority each box must trust, if any.
 * @returns the supervisor.
 */
/**
 * Build the Host/Origin fence arguments for one box.
 *
 * A box reached through the fleet gateway receives the browser's `Host`, but a
 * stock listener only accepts its own bind authority. Without an explicit
 * `--trusted-host` the fence answers `403` on every `/api` call and the UI sits
 * at "Reconnecting…" — verified against a running listener. `--public-url` is
 * added so the box advertises the address a browser actually uses, keeping its
 * printed URL and runtime context consistent with the prefix it is served under.
 *
 * @param box - the normalized box.
 * @param authority - external authority, or empty to keep the loopback default.
 * @param prefix - the box's URL prefix, e.g. `/box1`.
 * @returns the extra CLI arguments.
 */
export function trustedArgs(box, authority = '', prefix) {
  if (authority === undefined || authority === '') return []
  const args = ['--trusted-host', authority]
  if (prefix !== undefined) args.push('--public-url', `http://${authority}${prefix}/`)
  return args
}

export function createSupervisor({
  binPath,
  profileDir,
  homeDir,
  readyMs = 60_000,
  env = {},
  onExit,
  authority = '',
}) {
  /** @type {Map<string, { child: import('node:child_process').ChildProcess, port: number }>} */
  const running = new Map()
  /** Bounded recent output per box, kept after exit for diagnostics. */
  const logs = new Map()
  const LOG_LIMIT = 32_000

  const stop = (id) =>
    new Promise((done) => {
      const entry = running.get(id)
      if (entry === undefined) {
        done()
        return
      }
      running.delete(id)
      const child = entry.child
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.once('exit', () => {
        clearTimeout(force)
        done()
      })
      child.kill('SIGTERM')
    })

  return {
    /** Whether a box process is recorded as running. */
    isRunning(id) {
      return running.has(id)
    },

    /** The port of a running box, for the gateway. */
    portOf(id) {
      return running.get(id)?.port
    },

    /** Every running box id. */
    ids() {
      return [...running.keys()]
    },

    /**
     * Start one box and wait for its listener.
     *
     * The launch token is read from the child's own startup line rather than
     * invented here: the process owns its credential, and the fleet host must
     * not mint one on its behalf.
     *
     * @param box - the normalized box to run.
     * @returns the port and launch URL.
     * @throws {Error} when the process exits early or misses the deadline.
     */
    async start(box) {
      if (running.has(box.id)) throw new Error(`fleet: box "${box.id}" is already running`)
      const dir = profileDir(box.profile)
      const child = spawn(
        binPath,
        ['--profile', box.profile, '--port', String(box.port), '--no-open', ...trustedArgs(box, authority, `/${box.id}`)],
        {
          cwd: dir,
          env: { ...process.env, ...env, DSH_HOME: homeDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      running.set(box.id, { child, port: box.port })

      let log = ''
      const collect = (chunk) => {
        log += chunk.toString()
        // Keep only a bounded tail: the settings card shows recent lines, and a
        // long-running box must not grow the fleet host's heap without bound.
        if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT / 2)
        logs.set(box.id, log)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      let exited
      const exitPromise = new Promise((resolveExit) => {
        exited = resolveExit
        child.once('exit', (code, signal) => {
          const wasRunning = running.delete(box.id)
          resolveExit()
          if (wasRunning) onExit?.(box.id, code, signal)
        })
      })

      const ready = await Promise.race([
        waitForPort(box.port, readyMs),
        exitPromise.then(() => false),
      ])
      if (!ready) {
        await stop(box.id)
        throw new Error(`fleet: box "${box.id}" did not start listening on ${box.port}\n${log.trim()}`)
      }
      // The listener accepts connections just before the startup line reaches
      // our pipe, so give the announcement a bounded grace period rather than
      // reading the log at the instant the port opens.
      const url = await waitForStartupLine(() => log)
      return { port: box.port, url, log: () => log, exited }
    },

    /** Stop one box. */
    stop,

    /** Recent child output for one box; empty once the process has exited. */
    log(id) {
      return logs.get(id) ?? ''
    },

    /** Stop every box and wait for each process to exit. */
    async stopAll() {
      await Promise.all([...running.keys()].map((id) => stop(id)))
    },
  }
}
