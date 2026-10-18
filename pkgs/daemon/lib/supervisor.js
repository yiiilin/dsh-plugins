/**
 * Child-process supervisor for profiles.
 *
 * Each profile runs as its own `dsh --profile <name>` process. A profile cannot
 * share a process with another, because the filesystem, subprocess and sandbox
 * services are process-wide singletons: one `ctx.fs` means one execution world,
 * so two targets cannot be reached from one Harness process.
 *
 * The supervisor owns process lifetime and nothing else. It never treats the
 * child's output as a protocol; it waits for the listening port so a readiness
 * answer reflects a real listener rather than an optimistic timer.
 *
 * @module @yiln-dsh/dsh-daemon/supervisor
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
 * @param port - the port to watch.
 * @param deadlineMs - total wait in milliseconds.
 * @param intervalMs - delay between probes.
 * @returns true when the port came up.
 */
export async function waitForPort(port, deadlineMs, intervalMs = 250) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (await probePort(port)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}

/**
 * Read the launch URL from a profile's captured output.
 *
 * @param text - the output collected so far.
 * @returns the announced URL, or undefined when the line has not appeared.
 */
export function launchUrlFrom(text) {
  const match = /dsh web: (\S+)/u.exec(text ?? '')
  return match === null ? undefined : match[1]
}

/**
 * Pick up the launch URL a profile printed.
 *
 * `dsh web` announces one line carrying its one-time token. A profile is ready
 * once it listens, but the URL is what an operator needs to open it, so it is
 * read opportunistically rather than treated as a readiness signal.
 *
 * @param readLog - returns the output collected so far.
 * @param deadlineMs - how long to look for the line.
 * @returns the announced URL, or undefined when it never appeared.
 */
async function waitForStartupLine(readLog, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const match = /dsh web: (\S+)/u.exec(readLog())
    if (match !== null) return match[1]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

/**
 * Create the profile supervisor.
 *
 * @param options - process settings.
 * @param options.binPath - the `dsh` executable.
 * @param options.profileDir - resolves a profile name to its directory.
 * @param options.homeDir - `$DSH_HOME` handed to every child.
 * @param options.readyMs - how long a started profile may take to listen.
 * @param options.env - extra environment for children.
 * @param options.onExit - called with a profile id when its process exits.
 * @param options.publicUrl - renders the address a browser uses for a profile,
 *   or undefined to leave the profile's own loopback origin.
 * @returns the supervisor.
 */
export function createSupervisor({
  binPath,
  profileDir,
  homeDir,
  readyMs = 90_000,
  env = {},
  onExit,
  publicUrl,
}) {
  /** @type {Map<string, { child: import('node:child_process').ChildProcess, port: number }>} */
  const running = new Map()
  /** Bounded recent output per profile, kept after exit for diagnostics. */
  const logs = new Map()
  /** Launch URL per profile, cleared on stop so a stale token is never shown. */
  const urls = new Map()
  const LOG_LIMIT = 32_000

  const stop = (id) =>
    new Promise((done) => {
      const entry = running.get(id)
      if (entry === undefined) {
        done()
        return
      }
      running.delete(id)
      urls.delete(id)
      const child = entry.child
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }
      // A profile that ignores SIGTERM keeps its port, and the next start would
      // fail on a bound address; the hard kill is the fallback that frees it.
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
      child.once('exit', () => {
        clearTimeout(force)
        done()
      })
      child.kill('SIGTERM')
    })

  return {
    /** Whether a profile currently has a live process. */
    isRunning(id) {
      return running.has(id)
    },

    /** Every running profile id. */
    ids() {
      return [...running.keys()]
    },

    /** Recent child output for one profile; empty once the process has exited. */
    log(id) {
      return logs.get(id) ?? ''
    },

    /**
     * The launch URL a profile printed.
     *
     * The line is printed asynchronously, so it can land after the readiness
     * deadline; parsing the captured output on demand covers that case instead of
     * leaving a running profile with no reachable URL.
     */
    url(id) {
      const cached = urls.get(id)
      if (cached !== undefined) return cached
      const found = launchUrlFrom(logs.get(id))
      if (found !== undefined) urls.set(id, found)
      return found
    },

    /**
     * Start one profile and wait for its listener.
     *
     * The launch token is read from the child's own startup line rather than
     * invented here: the process owns its credential.
     *
     * @param profile - the profile to run.
     * @returns the port and launch URL.
     * @throws {Error} when the process exits early or misses the deadline.
     */
    async start(profile) {
      if (running.has(profile.id)) throw new Error(`daemon: profile "${profile.id}" is already running`)
      const dir = profileDir(profile.profile)
      const args = ['--profile', profile.profile, '--port', String(profile.port), '--no-open']
      const advertised = publicUrl?.(profile)
      if (advertised !== undefined) args.push('--public-url', advertised)
      const child = spawn(binPath, args, {
        cwd: dir,
        env: { ...process.env, ...env, DSH_HOME: homeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      running.set(profile.id, { child, port: profile.port })

      let log = ''
      const collect = (chunk) => {
        log += chunk.toString()
        // Keep only a bounded tail: the admin surface shows recent lines, and a
        // long-running profile must not grow the daemon's heap without bound.
        if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT / 2)
        logs.set(profile.id, log)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)

      const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          const wasRunning = running.delete(profile.id)
          urls.delete(profile.id)
          resolve({ code, signal })
          if (wasRunning) onExit?.(profile.id, code, signal)
        })
      })

      const listening = await Promise.race([
        waitForPort(profile.port, readyMs).then((ok) => (ok ? 'listening' : 'timeout')),
        exited.then(() => 'exited'),
      ])
      if (listening === 'exited') {
        const { code, signal } = await exited
        throw new Error(
          `daemon: profile "${profile.id}" exited before listening (code ${code}, signal ${signal})\n${log.trim()}`,
        )
      }
      if (listening === 'timeout') {
        child.kill('SIGKILL')
        throw new Error(`daemon: profile "${profile.id}" did not listen on ${profile.port} in ${readyMs}ms\n${log.trim()}`)
      }

      const url = await waitForStartupLine(() => log)
      if (url !== undefined) urls.set(profile.id, url)
      return { port: profile.port, url, log: () => log, exited }
    },

    stop,

    /** Stop every profile and wait for each process to exit. */
    async stopAll() {
      await Promise.all([...running.keys()].map((id) => stop(id)))
    },
  }
}
