/**
 * The per-workspace code-server instance table.
 *
 * One process per **DSH Workspace**, not per session: every session in the same
 * workspace shares one editor, so opening ten sessions costs one child instead
 * of ten. Ports are claimed **before** the first await, exactly as
 * `browser-vnc/instances.js` does, so two concurrent creates cannot both pick
 * the same free-looking port.
 *
 * Each workspace gets its own `user-data-dir` (settings, workspaceStorage,
 * coder.json), but **all instances share one `extensions-dir`**: VS Code
 * extensions are the expensive, install-once part, and duplicating them per
 * workspace wastes disk and forces every instance to install again. See the
 * README for the concurrent-write caveat of sharing that directory.
 *
 * A session ending no longer closes the instance — other sessions in the same
 * workspace may still be using it. Instances are released by an explicit close
 * (the panel's × button), a DELETE on /sessions, or plugin unload. Only
 * processes this registry spawned are stopped; nothing is killed by name.
 *
 * @module @yiln-dsh/dsh-code-server/instances
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

/** Instance ids are minted here and are also URL path segments. */
const INSTANCE_ID = /^cs-[1-9][0-9]*$/u

/** @returns whether `id` is one of this table's ids. */
export function isInstanceId(id) {
  return typeof id === 'string' && INSTANCE_ID.test(id)
}

/**
 * A stable, filesystem-safe directory name for one workspace.
 *
 * A hash is appended so two workspace ids that sanitize to the same label
 * cannot share a user-data directory (and therefore a `SingletonLock`).
 *
 * @param {string} workspaceId the owning DSH Workspace id, or a fallback label.
 * @returns {string} the directory name.
 */
export function workspaceDirName(workspaceId) {
  const raw = String(workspaceId)
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const label = raw.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 24)
  return `${label}-${hash}`
}

/**
 * The deterministic per-instance config file.
 *
 * Passing `--config` is what stops the host's own
 * `~/.config/code-server/config.yaml` from re-introducing a password or TLS.
 * CLI flags take priority over this file, but writing it makes the mount
 * independent of whatever a person has configured for their own code-server.
 *
 * @param {number} port the instance's loopback port.
 * @returns {string} YAML for code-server's config file.
 */
export function configYaml(port) {
  return `bind-addr: 127.0.0.1:${port}\nauth: none\ncert: false\n`
}

/**
 * The exact argv used to launch one instance.
 *
 * `folder` is the positional workspace argument, so VS Code opens that
 * workspace's directory rather than a remembered folder. `extensionsDir` is
 * deliberately **outside** `dir`: code-server's default puts extensions under
 * `--user-data-dir`, which would give every workspace its own copy.
 *
 * @param {object} options
 * @param {string} options.executable resolved executable path.
 * @param {number} options.port loopback port.
 * @param {string} options.dir this workspace's state directory.
 * @param {string} options.folder workspace folder to open.
 * @param {string} options.extensionsDir directory shared by every instance.
 * @param {string[]} [options.extraArgs] extra operator-configured arguments.
 * @returns {string[]} argv, never shell-interpreted.
 */
export function codeServerArgs({ executable, port, dir, folder, extensionsDir, sharedDataDir, extraArgs = [] }) {
  return [
    executable,
    '--config', join(dir, 'config.yaml'),
    '--bind-addr', `127.0.0.1:${port}`,
    '--auth', 'none',
    '--user-data-dir', join(dir, 'user-data'),
    '--extensions-dir', extensionsDir,
    // code-server has no flag of its own for VS Code's *shared* storage
    // (`sharedStorage/state.vscdb`), which otherwise lands in a single
    // machine-wide `~/.vscode-oss-shared` shared by every instance. Passing it
    // through `--vscode-option` (code-server's documented passthrough) keeps
    // each workspace's shared state inside DSH_HOME and isolates the instances.
    ...(typeof sharedDataDir === 'string' && sharedDataDir !== ''
      ? ['--vscode-option', `shared-data-dir=${sharedDataDir}`]
      : []),
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-getting-started-override',
    // `--ignore-last-opened` is deliberately NOT passed: code-server records
    // the opened folder in `coder.json`, and letting it read that back is what
    // restores the workspace after a restart. The `?folder=` URL still wins
    // when present (its precedence is workspace > folder > cli > last-opened),
    // so the panel keeps opening the current workspace.
    ...extraArgs,
    folder,
  ]
}

/** A sleep that never keeps the process alive on its own. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** @returns whether something is listening on a loopback port right now. */
function probePort(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already closed */ }
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Wait until the port answers, a deadline passes, or the instance is stopped. */
async function waitForPort(port, timeoutMs, isStopped) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isStopped()) return false
    if (await probePort(port)) return true
    await sleep(250)
  }
  return false
}

/** An error carrying the HTTP status the route should answer with. */
export function requestError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Create the instance table.
 *
 * @param {object} options
 * @param {Function} options.spawn `subprocess.spawn`.
 * @param {Function} options.resolveExecutable `subprocess.resolveExecutable`.
 * @param {string} options.executable configured command name or path.
 * @param {string} options.stateDir root directory for per-workspace state.
 * @param {string} [options.extensionsDir] shared extensions directory; defaults
 *   to `<stateDir>/extensions` so every instance reads the same installed set.
 * @param {number[]} [options.portRange] inclusive loopback port pool.
 * @param {string[]} [options.extraArgs] extra code-server arguments.
 * @param {number} [options.startupTimeoutMs] port-wait deadline.
 * @param {number} [options.stopGraceMs] how long to wait for a child to exit.
 * @param {Function} [options.log] diagnostic logger.
 * @param {Function} [options.now] injectable clock for tests.
 * @returns {object} the registry.
 */
export function createInstanceRegistry({
  spawn,
  resolveExecutable,
  executable,
  stateDir,
  extensionsDir = join(stateDir, 'extensions'),
  portRange = [14000, 14099],
  extraArgs = [],
  startupTimeoutMs = 30000,
  stopGraceMs = 2000,
  log = () => {},
  now = () => Date.now(),
}) {
  const ports = []
  for (let port = Number(portRange[0]); port <= Number(portRange[1]); port += 1) ports.push(port)
  const claimedPorts = new Set()
  const byId = new Map()
  const byWorkspace = new Map()
  const closeListeners = new Set()
  let nextId = 1

  /** Claim a port synchronously, before any await in `create`. */
  const claimPort = () => {
    for (const port of ports) {
      if (claimedPorts.has(port)) continue
      claimedPorts.add(port)
      return port
    }
    return null
  }

  /** The public, JSON-safe projection of one entry. */
  const row = (entry) => ({
    id: entry.id,
    workspaceId: entry.workspaceId,
    workspacePath: entry.cwd,
    workspaceTitle: entry.workspaceTitle,
    cwd: entry.cwd,
    port: entry.port,
    // Relative to `document.baseURI`, not to the site root: the GUI can be
    // served under an environment prefix such as `/main/`.
    url: `_dsh/code-server/i/${entry.id}/`,
    state: entry.state,
    error: entry.error,
    createdAt: entry.createdAt,
  })

  /** Stop exactly the child this registry started, once. */
  const terminate = (entry) => {
    if (entry.closing) return
    entry.closing = true
    try { entry.controller?.abort() } catch { /* best effort */ }
    try { entry.handle?.terminate?.() } catch { /* best effort */ }
  }

  /** Read the child's collected stderr for an honest failure message. */
  const readStderr = (entry) => {
    const reader = entry.handle?.collected?.stderr
    if (reader === undefined || reader === null) return ''
    try {
      return reader.readFrom(0).text.trim().split('\n')[0]
    } catch {
      return ''
    }
  }

  /**
   * Boot one instance and settle its `ready` promise.
   *
   * Never rejects: a failed boot is a `state: 'failed'` row with a readable
   * `error`, because the panel has to be able to explain it.
   */
  const boot = async (entry) => {
    try {
      // Both directories exist before the child starts: the shared one is
      // created by every instance (recursive mkdir is idempotent), so a
      // workspace can be the first one to boot without a race.
      //
      // `close()`/`disposeAll()` can run while any of these awaits is in
      // flight. It sets `closing` before this code resumes, so every await
      // must be followed by a stop check: otherwise a plugin unload would
      // leave a child spawned *after* the unload, with nobody to stop it.
      await mkdir(entry.dir, { recursive: true })
      if (entry.closing) return
      await mkdir(extensionsDir, { recursive: true })
      if (entry.closing) return
      await mkdir(join(entry.dir, 'shared'), { recursive: true })
      if (entry.closing) return
      await writeFile(join(entry.dir, 'config.yaml'), configYaml(entry.port), 'utf8')
      if (entry.closing) return
      if (typeof resolveExecutable !== 'function') throw new Error('subprocess service unavailable')
      if (typeof spawn !== 'function') throw new Error('subprocess service unavailable')
      const resolved = await resolveExecutable(executable)
      if (entry.closing) return
      const controller = new AbortController()
      const handle = spawn({
        argv: codeServerArgs({
          executable: typeof resolved === 'string' && resolved !== '' ? resolved : executable,
          port: entry.port,
          dir: entry.dir,
          folder: entry.cwd,
          extensionsDir,
          // Per-workspace shared storage, beside this workspace's user-data,
          // so no two workspaces share one `sharedStorage/state.vscdb`.
          sharedDataDir: join(entry.dir, 'shared'),
          extraArgs,
        }),
        cwd: entry.dir,
        // The subprocess service scrubs the parent environment. code-server
        // needs HOME for VS Code's own state and PATH to find its helpers.
        env: { HOME: homedir(), PATH: process.env.PATH ?? '' },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65536 },
          stderr: { maxBytes: 65536 },
        },
        graceMs: 5000,
        signal: controller.signal,
      })
      entry.controller = controller
      entry.handle = handle
      // The narrow window between `spawn()` returning and `close()` seeing the
      // handle: stop the child we just created instead of leaking it.
      if (entry.closing) {
        try { controller.abort() } catch { /* best effort */ }
        try { handle.terminate?.() } catch { /* best effort */ }
        return
      }

      // A child that exits on its own turns the row into a failure, so the
      // panel stops showing a dead iframe rather than an endless spinner.
      Promise.resolve(handle.done).then((outcome) => {
        if (entry.closing) return
        const detail = readStderr(entry)
        entry.state = 'failed'
        entry.error = detail !== ''
          ? detail
          : `code-server exited (code ${outcome?.exitCode ?? 'unknown'})`
        claimedPorts.delete(entry.port)
      }, (error) => {
        if (entry.closing) return
        entry.state = 'failed'
        entry.error = error instanceof Error ? error.message : String(error)
        claimedPorts.delete(entry.port)
      })

      const up = await waitForPort(entry.port, startupTimeoutMs, () => entry.closing || entry.state === 'failed')
      if (!up) {
        if (entry.state !== 'failed') {
          const detail = readStderr(entry)
          entry.state = 'failed'
          entry.error = detail !== '' ? detail : 'code-server did not start in time'
        }
        terminate(entry)
        return
      }
      entry.state = 'ready'
      entry.error = null
    } catch (error) {
      entry.state = 'failed'
      entry.error = error instanceof Error ? error.message : String(error)
      terminate(entry)
      log('warn', `code-server: instance ${entry.id} failed to start: ${entry.error}`)
    }
  }

  /**
   * Open one instance, or return the one this workspace already owns.
   *
   * Sessions are deliberately **not** ownership keys: several sessions in one
   * workspace must land on the same child, and closing one session must not
   * kill the editor its neighbours are using.
   *
   * @param {object} options
   * @param {string} options.workspaceId owning DSH Workspace id.
   * @param {string} options.cwd canonical workspace directory to open.
   * @param {string} [options.workspaceTitle] display title for the panel.
   * @returns {object} the public row, with `state: 'starting'` on a fresh boot.
   */
  const create = ({ workspaceId, cwd, workspaceTitle = '' }) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw requestError(400, 'workspaceId is required')
    }
    if (byWorkspace.has(workspaceId)) {
      // byWorkspace holds an **id**, not an entry; `row` needs the entry itself.
      const existing = byId.get(byWorkspace.get(workspaceId))
      if (existing !== undefined) return row(existing)
    }
    if (ports.length === 0) throw requestError(503, 'the code-server port pool is empty')
    const port = claimPort()
    if (port === null) throw requestError(503, 'no free port for a new code-server instance')
    const id = `cs-${nextId}`
    nextId += 1
    const entry = {
      id,
      workspaceId,
      workspaceTitle,
      cwd,
      port,
      dir: join(stateDir, 'workspaces', workspaceDirName(workspaceId)),
      state: 'starting',
      error: null,
      createdAt: Math.floor(now() / 1000),
      closing: false,
      handle: null,
      controller: null,
      ready: null,
    }
    // Register before the first await so a concurrent create sees the claim.
    byId.set(id, entry)
    byWorkspace.set(workspaceId, id)
    entry.ready = boot(entry)
    return row(entry)
  }

  /**
   * Close one instance and release its port and routes.
   *
   * @param {string} id the instance id.
   * @returns {Promise<{id: string, closed: boolean}>}
   */
  const close = async (id) => {
    const entry = byId.get(id)
    if (entry === undefined) throw requestError(404, `no such code-server instance: ${id}`)
    byId.delete(id)
    byWorkspace.delete(entry.workspaceId)
    claimedPorts.delete(entry.port)
    terminate(entry)
    // Release the routes before waiting for the child to exit: a closed
    // instance must stop answering on its old paths immediately, not after a
    // two-second grace that is only about reaping the process.
    for (const listener of closeListeners) {
      try { listener(id) } catch { /* one bad listener must not block the rest */ }
    }
    try {
      await Promise.race([
        Promise.resolve(entry.handle?.done).catch(() => {}),
        sleep(stopGraceMs),
      ])
    } catch { /* teardown is best-effort */ }
    return { id, closed: true }
  }

  /** @returns the public rows in table order. */
  const list = () => [...byId.values()].map(row)
  /** @returns one entry, or undefined. */
  const get = (id) => byId.get(id)
  /** @returns the first entry, or undefined. */
  const first = () => [...byId.values()][0]

  /** Close the whole table on unload. */
  const disposeAll = async () => {
    await Promise.allSettled([...byId.keys()].map((id) => close(id)))
  }

  /** @returns a disposer for a close listener. */
  const subscribeClose = (listener) => {
    closeListeners.add(listener)
    return () => closeListeners.delete(listener)
  }

  return { create, close, list, get, first, disposeAll, subscribeClose }
}
