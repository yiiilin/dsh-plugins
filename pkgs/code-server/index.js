/**
 * dsh-code-server — Host half.
 *
 * Embeds a host-installed `code-server` (VS Code in the browser) in the
 * Harness's right sidebar, **one process per DSH Workspace**. Every session in
 * a workspace shares that editor, and VS Code opens the workspace's canonical
 * path. The Client half owns the tab; this half owns everything the browser
 * cannot:
 *
 * - `/_dsh/code-server/state` — detection result, configured install command
 *   and the live instance table, for the panel's status and setup guide.
 * - `/_dsh/code-server/detect` — re-run detection after a manual install.
 * - `/_dsh/code-server/install` — run the **operator-configured** install
 *   command on an explicit, confirmed user action. The command never comes
 *   from the request body.
 * - `/_dsh/code-server/sessions` — list/create/close instances, one prefix
 *   route because ids are minted at runtime.
 * - `/_dsh/code-server/i/<id>/…` — one prefix HTTP route plus two exact
 *   upgrade routes per instance, registered and released with the instance.
 *
 * Why a loopback child and `--auth none` is safe here: only the Harness's
 * already-authenticated web server can reach `127.0.0.1`, so the code-server
 * process needs no second login. Exposing that port on a LAN interface would
 * turn it into unauthenticated remote code execution — see the README.
 *
 * @module @yiln-dsh/dsh-code-server
 */

import { request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import z from '@deepseek-ai/schemastery'

import { detect } from './detect.js'
import { createInstanceRegistry, isInstanceId, requestError, seedSharedSettings } from './instances.js'
import { isSameOriginRequest, proxyHttp, proxyUpgrade, upstreamPath } from './proxy.js'

export const name = 'code-server'

/** Host services this module reads. `workspaceRegistry` is read
 * opportunistically through `ctx.get` so the plugin stays mountable on every
 * DSH in the declared version window; the Client's workspace path is the
 * fallback. */
export const inject = ['webServer', 'subprocess']

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** Host-installed code-server command name or absolute path. */
  executable: z.string().default('code-server'),
  /** argv for the guided install; never shell-interpreted, never client-supplied.
   * `--loglevel=http` is deliberate: without it npm prints nothing while it
   * works (non-TTY), so a three-minute install looks frozen. */
  installCommand: z.array(z.string()).default(
    ['npm', 'install', '-g', '--loglevel=http', 'code-server'],
  ),
  /** Inclusive loopback port pool, one port per instance. */
  portRange: z.array(z.number()).default([14000, 14099]),
  /** Extra arguments appended to each code-server launch. */
  extraArgs: z.array(z.string()).default([]),
  /** Root of the per-workspace user-data / config directories and the shared
   * extensions directory. */
  stateDir: z.string().default(''),
  /** Override the shared `--extensions-dir`. Empty means `<stateDir>/extensions`,
   * so every workspace reads the same installed extension set. */
  extensionsDir: z.string().default(''),
  /** Override the shared `settings.json`. Empty means `<stateDir>/settings.json`. */
  settingsFile: z.string().default(''),
  /** One-time seed: the `<stateDir>/workspaces/<id>` directory whose existing
   * settings.json becomes the shared file. Empty disables seeding. */
  settingsSeedWorkspace: z.string().default(''),
  startupTimeoutMs: z.number().default(30000),
  installTimeoutMs: z.number().default(300000),
})

const PREFIX = '/_dsh/code-server'
const STATE_PATH = `${PREFIX}/state`
const DETECT_PATH = `${PREFIX}/detect`
const INSTALL_PATH = `${PREFIX}/install`
const INSTALL_LOG_PATH = `${PREFIX}/install/log`
const SESSIONS_PATH = `${PREFIX}/sessions`
/** Absolute pathname of one instance; the Client resolves this relative to `document.baseURI`. */
const instancePrefix = (id) => `${PREFIX}/i/${id}`

const NO_STORE = 'no-store, no-cache, must-revalidate'

/**
 * Extract the versioned root VS Code opens its WebSocket on.
 *
 * The served HTML references its scripts as
 * `<stable-commit>/static/out/vs/code/browser/workbench/workbench.js`, and
 * `patches/base-path.diff` builds the socket URL as
 * `location.pathname + "/" + <server root>` — which resolves to the
 * **`stable-<commit>` segment itself**, not the deeper workbench directory.
 * That was measured against a live instance: VS Code connected to
 * `<prefix>/stable-<commit>?reconnectionToken=…`, so only the versioned root
 * is needed here.
 *
 * @param {string} html the workbench page source.
 * @returns {string|null} e.g. `stable-<commit>`, or null when the page has no
 *   recognisable versioned root.
 */
export function workbenchStaticPrefix(html) {
  if (typeof html !== 'string') return null
  const match = /["'](stable-[0-9a-f]+)\/static\/out\/vs\/code\/browser\/workbench\//iu.exec(html)
  return match === null ? null : match[1]
}

/**
 * Read one bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req the request stream.
 * @param {number} [limit] byte cap.
 * @returns {Promise<unknown>} parsed body, `{}` when empty.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    body += chunk
  }
  if (body.length === 0) return {}
  return JSON.parse(body)
}


export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const enabled = config.enabled !== false
  const executable = typeof config.executable === 'string' && config.executable !== '' ? config.executable : 'code-server'
  const installCommand = Array.isArray(config.installCommand)
    ? config.installCommand.filter((entry) => typeof entry === 'string' && entry !== '')
    : []
  const portRange = Array.isArray(config.portRange) && config.portRange.length === 2
    ? config.portRange
    : [14000, 14099]
  const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.filter((a) => typeof a === 'string') : []
  const startupTimeoutMs = Number.isFinite(config.startupTimeoutMs) ? config.startupTimeoutMs : 30000
  const installTimeoutMs = Number.isFinite(config.installTimeoutMs) ? config.installTimeoutMs : 300000
  const stateDir = typeof config.stateDir === 'string' && config.stateDir !== ''
    ? config.stateDir
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'code-server')
  // One extensions directory for **every** instance. code-server's default is
  // `<user-data-dir>/extensions`, which would give each workspace its own copy.
  const extensionsDir = typeof config.extensionsDir === 'string' && config.extensionsDir !== ''
    ? config.extensionsDir
    : join(stateDir, 'extensions')
  // One `settings.json` for every instance, for the same reason: user settings
  // otherwise live under the per-workspace `--user-data-dir`, so a theme chosen
  // in one workspace did not apply to the others. This path may be seeded from
  // `settingsSeedWorkspace` once (see below) and is then linked from every
  // workspace's `user-data/User/settings.json`.
  const settingsFile = typeof config.settingsFile === 'string' && config.settingsFile !== ''
    ? config.settingsFile
    : join(stateDir, 'settings.json')

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger === undefined) return
      if (level === 'warn' && typeof logger.warn === 'function') logger.warn(message)
      else if (level === 'error' && typeof logger.error === 'function') logger.error(message)
      else if (typeof logger.info === 'function') logger.info(message)
    } catch {
      // Diagnostics must never break a request.
    }
  }

  const subprocess = ctx.get('subprocess')
  const spawn = subprocess === undefined ? undefined : (spec) => subprocess.spawn(spec)
  const resolveExecutable = subprocess === undefined
    ? undefined
    : (command) => subprocess.resolveExecutable(command)

  // The version probe has no reason to run in stateDir, which may not exist
  // yet on a fresh install. detect() defaults to tmpdir() for it.
  const detectNow = () => detect({ executable, resolveExecutable, spawn })
  /** The one in-flight (or settled) detection. Replaced only by /detect and /install. */
  let detectionPromise = detectNow()
  let installInFlight = false
  /**
   * The current (or last) guided install.
   *
   * `handle.collected.stdout/stderr` are offset readers, so this object only
   * keeps cursors rather than text: `text` is the accumulated tail the panel
   * displays, and `stdoutOffset`/`stderrOffset` are where the next incremental
   * read resumes. Keeping the offsets here is what lets several pollers read
   * independently without consuming one another's output.
   */
  const install = {
    phase: 'idle',   // idle | running | succeeded | failed
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    error: null,
    command: installCommand.join(' '),
    text: '',
    stdoutOffset: 0,
    stderrOffset: 0,
    handle: null,
  }
  /** How much install output to retain for the panel. */
  const INSTALL_TEXT_LIMIT = 20000

  /** Append one incremental read's text to the retained tail. */
  const appendInstallText = (chunk) => {
    if (typeof chunk !== 'string' || chunk === '') return
    install.text = (install.text + chunk).slice(-INSTALL_TEXT_LIMIT)
  }

  /** Drain whatever the child has produced since the last read. */
  const drainInstall = () => {
    const collected = install.handle?.collected
    if (collected === undefined || collected === null) return
    for (const stream of ['stdout', 'stderr']) {
      const reader = collected[stream]
      if (reader === undefined || reader === null) continue
      const key = stream === 'stdout' ? 'stdoutOffset' : 'stderrOffset'
      try {
        const read = reader.readFrom(install[key])
        appendInstallText(read.text)
        install[key] = read.nextOffset
      } catch {
        // A reader that cannot serve this cursor is not worth failing the job.
      }
    }
  }

  /** The snapshot the panel polls. */
  const installSnapshot = (since) => {
    drainInstall()
    return {
      phase: install.phase,
      command: install.command,
      startedAt: install.startedAt,
      finishedAt: install.finishedAt,
      exitCode: install.exitCode,
      error: install.error,
      // The whole retained tail: the panel re-renders the log from this rather
      // than tracking a cursor, so a trimmed tail can never duplicate text.
      text: install.text,
      running: install.phase === 'running',
    }
  }

  /**
   * Start the guided install in the background.
   *
   * Never throws at the caller: a spawn failure becomes `phase: 'failed'` with
   * a readable `error`, because the panel has to be able to show it.
   */
  const startInstall = () => {
    if (installInFlight) return
    installInFlight = true
    install.phase = 'running'
    install.startedAt = Date.now()
    install.finishedAt = null
    install.exitCode = null
    install.error = null
    install.text = ''
    install.stdoutOffset = 0
    install.stderrOffset = 0
    install.handle = null

    void (async () => {
      let timer
      try {
        await mkdir(stateDir, { recursive: true })
        let program = installCommand[0]
        try {
          const resolved = await resolveExecutable(program)
          if (typeof resolved === 'string' && resolved !== '') program = resolved
        } catch {
          // Let spawn produce the honest "command not found" failure.
        }
        const controller = new AbortController()
        timer = setTimeout(() => controller.abort(), installTimeoutMs)
        timer.unref?.()
        const handle = spawn({
          argv: [program, ...installCommand.slice(1)],
          cwd: stateDir,
          env: { HOME: homedir(), PATH: process.env.PATH ?? '' },
          stdio: {
            stdin: 'ignore',
            // A long npm install prints well past a single screen; keep a
            // generous tail so the panel's live view does not lose its head.
            stdout: { maxBytes: 262144 },
            stderr: { maxBytes: 262144 },
          },
          graceMs: 5000,
          signal: controller.signal,
        })
        install.handle = handle
        const outcome = await handle.done
        drainInstall()
        install.exitCode = outcome?.exitCode ?? null
        if (install.exitCode === 0) drainInstall()
        install.phase = 'succeeded'
      } catch (error) {
        drainInstall()
        install.phase = 'failed'
        install.error = error instanceof Error ? error.message : String(error)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        install.finishedAt = Date.now()
        installInFlight = false
        // The binary may be on PATH now, so re-detect before the panel asks.
        detectionPromise = detectNow()
        const installed = (await detectionPromise.catch(() => ({ installed: false }))).installed
        if (install.phase === 'succeeded' && installed !== true) {
          // The command exited 0 but the binary is not resolvable — usually a
          // PATH problem, and far clearer as its own state than as "succeeded".
          install.phase = 'failed'
          install.error = install.error ?? `${installCommand[0]} exited successfully but the binary is still not on PATH`
        }
        log(installed === true ? 'info' : 'warn',
          `code-server: guided install ${installed === true ? 'succeeded' : 'did not install the binary'}`)
      }
    })()
  }

  /**
   * Which workspaces should have an editor after a restart.
   *
   * The table itself cannot survive: instances are processes, and a restart
   * kills them. What is worth keeping is the *intent* — "these workspaces had
   * an editor open" — so the Host can rebuild them on the next start instead
   * of making the user reopen the tab. Written on every create/close, and kept
   * beside the per-workspace state so it lives and dies with DSH_HOME.
   */
  const liveFile = join(stateDir, 'live-workspaces.json')

  /**
   * The last write still in flight.
   *
   * Creates and closes fire this in bursts (a restore loop opens several
   * instances), and two overlapping `writeFile` calls to one path interleave
   * their bytes — the file then holds two documents and no longer parses, which
   * silently loses the whole restore list. Chaining keeps one writer at a time.
   */
  let liveWrite = Promise.resolve()

  /** Record the workspaces that currently own an instance. */
  const recordLive = (rows) => {
    try {
      const workspaces = rows.map((row) => ({
        workspaceId: row.workspaceId,
        workspacePath: row.workspacePath,
        workspaceTitle: row.workspaceTitle,
      }))
      const payload = `${JSON.stringify({ workspaces }, null, 2)}\n`
      liveWrite = liveWrite
        .then(() => mkdir(stateDir, { recursive: true }))
        .then(() => writeFile(liveFile, payload, 'utf8'))
        .catch((error) => {
          log('warn', `code-server: could not persist the live workspace list: ${error instanceof Error ? error.message : String(error)}`)
        })
    } catch (error) {
      log('warn', `code-server: could not persist the live workspace list: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Read the recorded workspaces, tolerating a missing or corrupt file. */
  const readLive = async () => {
    try {
      const text = await readFile(liveFile, 'utf8')
      const parsed = JSON.parse(text)
      const workspaces = Array.isArray(parsed?.workspaces) ? parsed.workspaces : []
      return workspaces.filter((entry) => entry !== null && typeof entry === 'object'
        && typeof entry.workspaceId === 'string' && entry.workspaceId !== ''
        && typeof entry.workspacePath === 'string' && entry.workspacePath !== '')
    } catch {
      return []
    }
  }

  /**
   * Seed the shared settings file from an existing workspace, once.
   *
   * Sharing only takes effect for workspaces that boot after this change; the
   * workspace the user already configured keeps its own file (the linker
   * refuses to replace a real one). Copying that file into the shared location
   * the first time makes the existing configuration the baseline instead of
   * silently starting from empty defaults.
   */
  void (async () => {
    const seed = typeof config.settingsSeedWorkspace === 'string' ? config.settingsSeedWorkspace : ''
    if (seed === '') return
    const source = join(stateDir, 'workspaces', seed, 'user-data', 'User', 'settings.json')
    const seeded = await seedSharedSettings({ settingsFile: source, sharedFile: settingsFile, log })
    if (seeded) log('info', `code-server: seeded shared settings from ${source}`)
  })()

  const registry = createInstanceRegistry({
    spawn,
    resolveExecutable,
    executable,
    stateDir,
    extensionsDir,
    settingsFile,
    portRange,
    extraArgs,
    startupTimeoutMs,
    // Test seam: a stub child never exits, so `close()` must not sit on the
    // production grace period. Not a user-facing option.
    ...(Number.isFinite(config.stopGraceMs) ? { stopGraceMs: config.stopGraceMs } : {}),
    log,
    onChanged: recordLive,
  })

  /**
   * Resolve the DSH Workspace an instance belongs to.
   *
   * `workspaceRegistry` is authoritative: `Workspace.path` is the canonical
   * realpath recorded at creation and is never rewritten, so a stale or forged
   * Client hint cannot point the editor at a different directory. The Client's
   * `workspacePath` is only a fallback for a DSH build without that service
   * (it is the same `useWorkspaces(...).path` the built-in Workspace UI reads).
   *
   * A session not yet attached to its Workspace still has to land on the same
   * instance as everyone else in that directory, so the canonical path is a
   * second lookup key when the id is unknown.
   *
   * @param {object} input the create request's workspace fields.
   * @returns {{workspaceId: string, cwd: string, workspaceTitle: string}}
   */
  const resolveWorkspace = ({ workspaceId, workspacePath, workspaceTitle }) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw requestError(400, 'workspaceId is required')
    }
    const store = ctx.get('workspaceRegistry')
    let workspace
    try {
      workspace = typeof store?.get === 'function' ? store.get(workspaceId) : undefined
    } catch { /* optional across the declared version window */ }
    if (workspace === undefined || workspace === null) {
      try {
        const items = typeof store?.list === 'function' ? store.list() : []
        if (typeof workspacePath === 'string' && workspacePath !== '') {
          workspace = items.find((candidate) => candidate?.path === workspacePath)
        }
      } catch { /* optional */ }
    }
    let cwd = ''
    if (workspace !== undefined && workspace !== null && typeof workspace.path === 'string') cwd = workspace.path
    else if (typeof workspacePath === 'string') cwd = workspacePath
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
      throw requestError(400, 'an absolute workspace directory is required')
    }
    const id = workspace !== undefined && workspace !== null
      && typeof workspace.id === 'string' && workspace.id !== ''
      ? workspace.id
      : workspaceId
    const title = workspace !== undefined && workspace !== null
      && typeof workspace.title === 'string' && workspace.title !== ''
      ? workspace.title
      : (typeof workspaceTitle === 'string' ? workspaceTitle : '')
    return { workspaceId: id, cwd, workspaceTitle: title }
  }

  const sendJson = (res, status, value) => {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
      'cache-control': NO_STORE,
    })
    res.end(payload)
  }

  const mutationAllowed = (req) => isSameOriginRequest(req.headers?.origin, req.headers?.host)

  /**
   * Extra upgrade paths registered for an instance's workbench socket,
   * keyed by instance id and exposed through /state for diagnosis.
   */
  const workbenchPaths = new Map()

  const stateDoc = async () => {
    const detection = await detectionPromise
    // The install projection rides on /state so a panel that reconnects (or is
    // opened after the install started) sees the run in progress rather than
    // an idle setup guide with no explanation.
    drainInstall()
    return {
      enabled,
      installed: detection.installed,
      executable: detection.executable,
      executablePath: detection.path,
      version: detection.version,
      installCommand: installCommand.join(' '),
      extensionsDir,
      install: {
        phase: install.phase,
        running: install.phase === 'running',
        exitCode: install.exitCode,
        error: install.error,
      },
      // Diagnosis only: the exact upgrade path registered for each instance's
      // workbench socket. Absent means the probe has not (yet) succeeded.
      workbenchPaths: Object.fromEntries(workbenchPaths),
      instances: registry.list(),
    }
  }

  /** Register a named route as an effect, so unloading releases it. */
  const registerRoute = (route) => ctx.effect(() => webServer.register(route))

  // --- 1. state -------------------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      try {
        sendJson(res, 200, await stateDoc())
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // --- 2. re-detection ------------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: DETECT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!mutationAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden origin' })
        return
      }
      detectionPromise = detectNow()
      try {
        sendJson(res, 200, await stateDoc())
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // --- 3. guided install ----------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: INSTALL_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      if (!mutationAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden origin' })
        return
      }
      let body = {}
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
        sendJson(res, 400, { error: 'confirm: true is required' })
        return
      }
      if (!enabled) {
        sendJson(res, 503, { error: 'code-server plugin is disabled' })
        return
      }
      if ((await detectionPromise).installed) {
        sendJson(res, 409, { error: 'code-server is already installed' })
        return
      }
      if (installInFlight) {
        sendJson(res, 409, { error: 'an install is already running' })
        return
      }
      if (installCommand.length === 0 || typeof spawn !== 'function' || typeof resolveExecutable !== 'function') {
        sendJson(res, 400, { error: 'installCommand and the subprocess service are required' })
        return
      }
      // Answer immediately and let the install run in the background. The
      // process can take minutes (code-server is ~187 MiB), so holding the
      // response open would give the panel nothing to show in the meantime;
      // the panel polls /install/log for the live output instead.
      startInstall()
      sendJson(res, 202, { started: true, state: await stateDoc() })
    },
  })

  // --- 3b. guided install log ---------------------------------------------
  // The panel polls this while an install runs: `nextOffset` is the cursor to
  // pass as `?since=`, so it receives only the new bytes each time.
  registerRoute({
    kind: 'exact',
    path: INSTALL_LOG_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      sendJson(res, 200, installSnapshot())
    },
  })

  // --- 4. instance table ----------------------------------------------------
  registerRoute({
    kind: 'prefix',
    path: SESSIONS_PATH,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const rest = url.pathname.startsWith(`${SESSIONS_PATH}/`)
        ? url.pathname.slice(SESSIONS_PATH.length + 1)
        : ''

      if (rest === '') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, registry.list())
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        if (!mutationAllowed(req)) {
          sendJson(res, 403, { error: 'forbidden origin' })
          return
        }
        if (!enabled) {
          sendJson(res, 503, { error: 'code-server plugin is disabled' })
          return
        }
        if (!(await detectionPromise).installed) {
          sendJson(res, 503, { error: `${executable} is not installed on this host` })
          return
        }
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'request body must be an object' })
          return
        }
        try {
          const workspace = resolveWorkspace({
            workspaceId: body.workspaceId,
            workspacePath: body.workspacePath,
            workspaceTitle: body.workspaceTitle,
          })
          const created = registry.create(workspace)
          mountInstance(created.id)
          sendJson(res, 200, created)
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 500
          sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      const [id, ...trailing] = rest.split('/')
      if (trailing.length > 0 || !isInstanceId(id)) {
        sendJson(res, 404, { error: `no such code-server instance: ${id}` })
        return
      }
      if (req.method !== 'DELETE') {
        res.writeHead(405, { allow: 'DELETE' })
        res.end()
        return
      }
      if (!mutationAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden origin' })
        return
      }
      try {
        sendJson(res, 200, await registry.close(id))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  // --- 5. per-instance routes ----------------------------------------------
  // `registerUpgrade` is an exact pathname lookup in the Host web server (there
  // is no prefix form), so the two WebSocket paths VS Code can produce are
  // registered explicitly. `patches/base-path.diff` builds the socket path from
  // `window.location.pathname + "/" + path`; with the iframe at `<prefix>/`
  // both the empty and the "/" form of `path` normalise to `<prefix>/`.
  const instanceRoutes = new Map()

  /** Call every disposer once, whether close or unload got there first. */
  const release = (disposers) => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* already released */ }
    }
  }

  /**
   * Find the exact path VS Code will open its WebSocket on.
   *
   * The workbench HTML references its scripts as
   * `<stable-commit>/static/out/vs/code/browser/workbench/workbench.js`, and
   * `patches/base-path.diff` makes the socket URL
   * `location.pathname + "/" + <that directory>/`. Reading the prefix from the
   * page the instance itself serves is what keeps this correct across
   * code-server releases instead of hard-coding a commit.
   *
   * @param {object} entry the instance.
   * @returns {Promise<string|null>} the absolute upgrade path, or null.
   */
  const probeWorkbenchSocketPath = async (id) => {
    const entry = registry.get(id)
    if (entry === undefined) return null
    await entry.ready
    if (entry.state !== 'ready' || entry.closing) return null
    // `?folder=` matters: without it code-server redirects to its
    // last-opened page and the first response carries no workbench markup.
    const fetchText = (path, depth = 0) => new Promise((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: entry.port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${entry.port}`, accept: 'text/html' },
      }, (answer) => {
        if (answer.statusCode >= 300 && answer.statusCode < 400 && answer.headers.location !== undefined && depth < 3) {
          answer.resume()
          const next = new URL(answer.headers.location, `http://127.0.0.1:${entry.port}/`)
          resolve(fetchText(`${next.pathname}${next.search}`, depth + 1))
          return
        }
        if (answer.statusCode !== 200) {
          answer.resume()
          reject(new Error(`workbench answered HTTP ${answer.statusCode}`))
          return
        }
        let body = ''
        answer.setEncoding('utf8')
        answer.on('data', (chunk) => { if (body.length < 262144) body += chunk })
        answer.on('end', () => resolve(body))
      })
      request.on('error', reject)
      request.end()
    })
    try {
      const html = await fetchText(`/?folder=${encodeURIComponent(entry.cwd)}`)
      const staticPrefix = workbenchStaticPrefix(html)
      if (staticPrefix === null) {
        log('warn', `code-server: could not find the workbench static prefix for ${entry.id}`)
        return null
      }
      return `${instancePrefix(entry.id)}/${staticPrefix}`
    } catch (error) {
      log('warn', `code-server: workbench probe for ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  const handleUpgrade = (id, prefix) => async (req, socket, head) => {
    if (!isSameOriginRequest(req.headers?.origin, req.headers?.host)) {
      log('warn', `code-server: refused websocket from origin ${req.headers?.origin}`)
      socket.destroy()
      return
    }
    const entry = registry.get(id)
    if (entry === undefined) {
      socket.destroy()
      return
    }
    await entry.ready
    if (entry.state !== 'ready') {
      log('warn', `code-server: refusing websocket for ${id}: ${entry.error ?? 'not ready'}`)
      socket.destroy()
      return
    }
    proxyUpgrade({ req, socket, head, port: entry.port, path: upstreamPath(req.url, prefix) })
  }

  const mountInstance = (id) => {
    if (instanceRoutes.has(id)) return
    const prefix = instancePrefix(id)
    const disposers = []
    ctx.effect(() => {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (req, res) => {
          const entry = registry.get(id)
          if (entry === undefined) {
            sendJson(res, 404, { error: `no such code-server instance: ${id}` })
            return
          }
          await entry.ready
          if (entry.state !== 'ready') {
            sendJson(res, 503, { error: entry.error ?? 'code-server is not ready' })
            return
          }
          proxyHttp({ req, res, port: entry.port, path: upstreamPath(req.url, prefix), prefix })
        },
      }))
      const upgrade = handleUpgrade(id, prefix)
      disposers.push(webServer.registerUpgrade({ path: prefix, handler: upgrade }))
      disposers.push(webServer.registerUpgrade({ path: `${prefix}/`, handler: upgrade }))
      // VS Code's WebSocket is not at `<prefix>/`: `patches/base-path.diff`
      // builds it from `window.location.pathname + "/" + path`, where `path`
      // is the workbench's own static directory
      // (`stable-<commit>/static/out/vs/code/browser/workbench/`). The Host's
      // upgrade table is an exact-path Map with no prefix form, so that one
      // route has to be registered explicitly — and its `<commit>` is only
      // known once the instance is running, hence the probe below.
      void probeWorkbenchSocketPath(id).then((socketPath) => {
        if (socketPath === null) {
          log('warn', `code-server: no workbench socket path for ${id}`)
          return
        }
        try {
          // VS Code appends a trailing slash when it joins the directory with
          // its socket path, so BOTH spellings have to answer: the Host's
          // upgrade table is exact-match, and one of them would 404 (1006 on
          // the browser side) otherwise.
          const registered = []
          for (const candidate of [socketPath, `${socketPath}/`]) {
            disposers.push(webServer.registerUpgrade({
              path: candidate,
              handler: handleUpgrade(id, prefix),
            }))
            registered.push(candidate)
          }
          workbenchPaths.set(id, registered)
          log('info', `code-server: registered workbench socket paths ${registered.join(', ')}`)
        } catch (error) {
          log('warn', `code-server: cannot register the workbench upgrade path ${socketPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, (error) => {
        // The instance still works over HTTP; only its workbench socket would
        // be missing, and a missing extra route must not fail the request.
        log('warn', `code-server: workbench socket probe failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return () => release(disposers)
    })
    instanceRoutes.set(id, () => release(disposers))
  }

  /**
   * Bring back the editors that were running before the last restart.
   *
   * A restart kills every instance (they live in this process's cgroup), so
   * without this the user has to reopen the tab to get an editor again. The
   * recorded set is *intent*, not liveness: a workspace someone deliberately
   * closed was removed from the file, so only the ones still wanted come back.
   *
   * Placed after `mountInstance` because it calls it; a `typeof` guard earlier
   * in `apply` would hit the const's temporal dead zone before this point.
   */
  void detectionPromise.then(async (detection) => {
    if (detection.installed !== true) return
    const recorded = await readLive()
    if (recorded.length === 0) return
    let restored = 0
    for (const entry of recorded) {
      try {
        // `create` is idempotent per workspace, so a duplicate record or a
        // workspace recreated by an early request is not a second process.
        const created = registry.create({
          workspaceId: entry.workspaceId,
          cwd: entry.workspacePath,
          workspaceTitle: typeof entry.workspaceTitle === 'string' ? entry.workspaceTitle : '',
        })
        mountInstance(created.id)
        restored += 1
      } catch (error) {
        log('warn', `code-server: could not restore ${entry.workspacePath}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (restored > 0) {
      log('info', `code-server: restored ${restored} editor(s) from the previous run`)
    }
  }, () => {
    // Detection failed; nothing to restore against.
  })

  // A closed instance must stop answering on its old paths at once, not only
  // when the whole plugin unloads.
  ctx.effect(() => registry.subscribeClose((id) => {
    const unmount = instanceRoutes.get(id)
    if (unmount === undefined) return
    instanceRoutes.delete(id)
    unmount()
  }))

  // --- 6. unload ------------------------------------------------------------
  // Deliberately no `session/disposed` listener: an instance belongs to a
  // Workspace, and other sessions in that Workspace may still be using it when
  // one of them ends. Instances are released by the panel's close button, an
  // explicit DELETE, or plugin unload.
  ctx.effect(() => () => {
    void Promise.resolve(registry.disposeAll()).catch(() => {})
  })
}

/** Attach inject on the default export too: the loader unwraps `default`. */
apply.inject = inject

export default apply
