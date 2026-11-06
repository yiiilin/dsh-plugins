/**
 * The federation daemon.
 *
 * One plugin, two roles:
 *
 * - `main` — accepts tunnels from edges and is the only place that can list and switch
 *   between environments. Its own UI is served under `/<rootPrefix>/`.
 * - `edge` — dials the main node and forwards the traffic that arrives. Its own UI is
 *   served at `/` and it is fully usable while the main node is unreachable.
 *
 * Both roles keep a daemon-owned listener on `0.0.0.0:<port>` with their own login, so
 * either can be reached directly. That is a separate concern from the tunnel, which is
 * authenticated by the environment token — see `docs/changes/federation-design.md` §5.
 *
 * There is no child process, no ssh, no helper and no per-environment port: every
 * environment is another machine's dsh, and an environment exists only while its tunnel
 * is up.
 *
 * @module @yiln-dsh/dsh-gateway
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createAdmin } from './lib/admin.js'
import { createAuth } from './lib/auth/session.js'
import { sendPwaAsset } from './lib/auth/pwa.js'
import { startEntry } from './lib/entry.js'
import { createProfileProcesses } from './lib/profile-process.js'
import { createTunnelAgent } from './lib/federation/agent.js'
import { createTunnelHub, createTunnelServer, tokenOf, TUNNEL_PATH } from './lib/federation/hub.js'
import { deliverToSession } from './lib/agent-message.js'
import { listSessions, listWorkspaces } from './lib/remote-info.js'
import { serveFileRoute } from './lib/file-route.js'
import { openStreamSink, validateDestination } from './lib/file-transfer.js'
import { agentMessageTools } from './tools.js'
import { defaultSkillsRoot, readInventory } from './lib/inventory.js'
import { installUnit, renderUnit, underSystemd, unitNameFor } from './lib/systemd.js'
import {
  extractModelRows,
  replaceModelRows,
  summarizeModelRows,
} from './lib/model-config.js'
import { parseRegistry, serializeRegistry } from './lib/registry.js'

export const name = 'gateway'

/** Nothing is injected: the daemon owns its listener and reads the harness port. */
export const inject = []

export const Config = z.object({
  /** Only public listener. TLS terminates at an external proxy. */
  host: z.string().default('0.0.0.0'),
  port: z.natural().max(65535).default(3080),

  /**
   * Whether this node accepts incoming tunnels.
   *
   * Independent of whether it dials out: a node may be someone's upstream and someone
   * else's downstream at once. `role` encoded both questions in one value, which made
   * that shape unrepresentable.
   */
  accept: z.boolean().default(true),

  /**
   * The nodes this one dials out to.
   *
   * An array because the topology is a graph rather than a two-level star: a node can
   * report to several upstreams, and has to keep working when one is unreachable. Each
   * entry carries its own token, because the identity is per link, not per node.
   */
  upstreams: z.array(z.object({
    url: z.string().description('Base URL of the upstream node'),
    token: z.string().description('This node\'s token on that link'),
    label: z.string().default('').description('Shown in the panel; defaults to the URL'),
  })).default([]),

  /**
   * Retired single-upstream model, still read so an existing profile boots.
   *
   * Reported at mount so the operator learns these no longer decide anything instead of
   * believing an old key is still in force.
   */
  role: z.union([z.const('main'), z.const('edge')]).default('main'),
  mainUrl: z.string().default(''),
  token: z.string().default(''),

  registryPath: z.string().default(''),
  /** Profile this process serves. Empty reads DSH_PROFILE, then `main`. */
  profile: z.string().default(''),
  homeDir: z.string().default(''),
  cacheDir: z.string().default(''),

  /** Realm shown on the login page. There is no password key: the credential lives
   * in `daemon/auth/pairing.json` and nowhere else — see `retiredKeys` below. */
  realm: z.string().default('dsh-daemon'),
  sessionMaxAgeSeconds: z.natural().default(2_592_000),
  sessionIdleSeconds: z.natural().default(0),

  /** Serve this process's own harness behind the daemon. */
  rootEmbedded: z.boolean().default(true),
  /** Path prefix the harness is mounted under. Empty serves it at the origin root. */
  rootPrefix: z.string().default(''),

  /**
   * systemd unit running this process, shown on the panel. Empty hides the restart
   * control: a daemon should not restart a unit it cannot name, and guessing restarts
   * the wrong deployment.
   */
  selfUnit: z.string().default(''),
  /**
   * Whether to install a systemd unit for this process.
   *
   * The unit is always named `dsh-daemon`. `auto` (the default) writes and enables it when
   * this process is not already supervised — a daemon started by hand stops existing at
   * the next reboot, and nothing says so until someone tries to use it. Empty opts out.
   */
  systemdUnit: z.union([z.const('auto'), z.const(''), z.const('dsh-daemon')]).default('auto'),
  /** `system` scope needs root; `user` scope works for an unprivileged daemon. */
  systemdScope: z.union([z.const('system'), z.const('user')]).default('system'),

  /**
   * Port pool for `local` environments this node spawns itself, `[low, high]`
   * inclusive. A port that already answers belongs to somebody else and is skipped,
   * never adopted, so the pool only has to be clear of this node's other listeners.
   */
  localProfilePortRange: z.array(z.number()).default([57_000, 57_099]),
})

export function apply(ctx, config) {
  const processStartMs = Date.now() - Math.round(process.uptime() * 1000)
  const homeDir = resolve(config.homeDir === '' ? process.env.DSH_HOME ?? '/root/.dsh' : config.homeDir)

  /**
   * Spawn one local profile child.
   *
   * `stdio` keeps the child's own streams reachable by the table that watches for the
   * launch line; `detached: false` keeps it in this process group so a daemon shutdown
   * reaches it.
   *
   * @param {{ command: string, args: string[], env: object, cwd: string }} spec
   * @returns {import('node:child_process').ChildProcess}
   */
  const spawnChild = (spec) => spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const registryPath = resolve(
    config.registryPath === '' ? join(homeDir, 'daemon', 'environments.json') : config.registryPath,
  )
  const cacheDir = resolve(config.cacheDir === '' ? join(homeDir, 'daemon', 'cache') : config.cacheDir)
  const daemonDir = resolve(join(homeDir, 'daemon'))

  /** Environments as last read or written. */
  let environments = []
  let loaded = false
  let entry

  const logger = {
    info: (message) => ctx.logger?.info?.(message) ?? process.stdout.write(`${message}\n`),
    warn: (message) => ctx.logger?.warn?.(message) ?? process.stderr.write(`${message}\n`),
  }

  const registry = {
    list: () => environments,
    find: (id) => environments.find((environment) => environment.id === id),
    usedIds: () => new Set(environments.map((environment) => environment.id)),
    /** Resolve a token to the environment that owns it. */
    byToken: (token) => environments.find((environment) => environment.token === token),
    async add(environment) {
      environments = [...environments, environment]
      await registry.save()
      return environment
    },
    async update(id, patch) {
      const current = registry.find(id)
      if (current === undefined) throw new Error(`daemon: unknown environment "${id}"`)
      const next = { ...current, ...patch }
      environments = environments.map((item) => (item.id === id ? next : item))
      await registry.save()
      return next
    },
    async remove(id) {
      const found = registry.find(id)
      if (found === undefined) throw new Error(`daemon: unknown environment "${id}"`)
      environments = environments.filter((item) => item.id !== id)
      await registry.save()
      return found
    },
    async save() {
      // Re-validated on write so no caller can persist a registry that violates the
      // token-ownership rule.
      await writeRegistry(registryPath, parseRegistry({ environments }))
    },
  }

  /**
   * Put one message into a session on this machine.
   *
   * The service is looked up per call, not captured: `sessionController` belongs to the
   * harness this process is attached to, and a lookup at mount time would pin whichever
   * instance existed then.
   */
  /**
   * Resolved once at mount, the way every plugin obtains a Remote service.
   *
   * `sessionController` is a Remote service rather than a context service, so `ctx.get`
   * answers `undefined` for it even while it is mounted — the first draft of this file
   * made exactly that mistake and reported "no session controller" on a node that had
   * one. dsh-bot reaches it the same way.
   */
  const sessionController = { current: undefined }
  /** What a peer may read: the workspace table and the session corpus behind it. */
  const remoteInfo = { workspaces: undefined, sessions: undefined }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionController', 'workspaceRegistry', 'sessionQuery'], (injected) => {
      sessionController.current = injected.sessionController
      remoteInfo.workspaces = injected.workspaceRegistry
      remoteInfo.sessions = injected.sessionQuery
      return () => {
        sessionController.current = undefined
        remoteInfo.workspaces = undefined
        remoteInfo.sessions = undefined
      }
    })
  }

  const deliverMessage = async (message) => {
    const sessions = sessionController.current
    if (sessions === undefined) return { ok: false, error: 'this node has no session controller' }
    return await deliverToSession({ sessions, logger }, message)
  }

  /**
   * Route one message to another environment, from the main node.
   *
   * Only the main node holds the other edges' tunnels, so only it can do this; an edge
   * gets `undefined` and answers "this node does not route".
   */
  const forwardMessage = config.role !== 'main'
    ? undefined
    : (toEnvId, message) => hub.sendAgentMessage(toEnvId, message)

  const hub = createTunnelHub({
    logger,
    verifyToken: (token) => registry.byToken(token),
    deliver: deliverMessage,
    forward: forwardMessage,
    /**
     * The node table the main node broadcasts.
     *
     * The main node is the authority: it is the only node holding every tunnel, so it is
     * the only one whose answer is complete. This node appears as `self`.
     */
    listNodes: config.role !== 'main'
      ? undefined
      : () => [
        { envId: 'self', label: 'this node (main)', kind: 'self', online: true },
        ...registry.list().map((environment) => ({
          envId: environment.id,
          label: environment.label,
          kind: environment.kind,
          hostname: environment.hostname ?? '',
          lastSeen: environment.lastSeen ?? 0,
          online: hub.isOnline(environment.id),
        })),
      ],
    // What an edge asks for: this node's environment table, with live state.
    listEnvironments: () => [
      { envId: 'self', label: 'this node (main)', online: true },
      ...registry.list().map((environment) => ({
        envId: environment.id,
        label: environment.label,
        online: hub.isOnline(environment.id),
      })),
    ],
  })
  const tunnelServer = createTunnelServer()

  /** Facts about this process, shown on the panel. */
  const selfInfo = () => {
    const started = processStartMs
    let plugins
    try {
      plugins = ctx.registry?.size ?? ctx.root?.registry?.size
    } catch {
      plugins = undefined
    }
    return {
      role: config.role,
      host: config.host,
      port: config.port,
      // Where this node's own UI is mounted, so a switcher can mark it as current.
      rootPrefix: config.rootPrefix,
      plugins,
      startedAt: started,
      uptimeMs: Date.now() - started,
      systemd: systemdState,
      restartable: config.selfUnit !== '',
      unit: config.selfUnit === '' ? undefined : config.selfUnit,
    }
  }

  // The credential model is one pairing credential, and it comes from exactly one
  // place: the scrypt hash in `daemon/auth/pairing.json`. There is no configured seed
  // and no environment fallback, so no plaintext copy of the credential exists at all —
  // not in the profile, not in the launch environment, not in a log line.
  //
  // The keys and variables below belonged to models that no longer exist, `password`
  // and `DSH_AUTH_PASS`/`AUTH_PASS` among them: they used to hash themselves into the
  // file on the first start. A profile that still sets them is not an error —
  // schemastery merges unknown keys rather than rejecting them — but ignoring them in
  // silence would let a deployment believe they still decide who can log in.
  //
  // The retired model keys are reported when present at all; the two password forms
  // are reported only when non-empty, because the old semantics were "empty means not
  // configured". The shipped patch used to carry `password: ''`, so warning on the
  // empty value would raise a false alarm on every deployment that ever ran a default
  // install and teach operators to ignore the one message that matters.
  const retiredKeys = ['username', 'twoFactorEnabled', 'totpSecret', 'passkeyOrigin', 'passkeyRpId']
  const retiredEnvironmentKeys = ['DSH_AUTH_PASS', 'AUTH_PASS']
  const stillConfigured = [
    ...retiredKeys.filter((key) => Object.hasOwn(config, key)),
    // Presence only: the value is never read here. A password that is set at all is
    // worth reporting, and reading it to decide would put the plaintext in a variable
    // for no reason — `''` is the one exception, because the shipped patch carried
    // `password: ''` for years and warning on that would fire on every install.
    // `Object.hasOwn` proves presence without touching the value; an empty string is
    // the one case not worth a warning, because the shipped patch carried
    // `password: ''` for years and warning on it would fire on every install.
    ...(Object.hasOwn(config, 'password') && config.password !== '' ? ['password'] : []),
    ...retiredEnvironmentKeys.filter((key) => Object.hasOwn(process.env, key) && process.env[key] !== ''),
  ]
  if (stillConfigured.length > 0) {
    logger.warn?.(
      `daemon: ignoring ${stillConfigured.join(', ')} — the login model is one pairing credential read from daemon/auth/pairing.json, and these no longer do anything`,
    )
  }
  const auth = createAuth({
    directory: join(homeDir, 'daemon', 'auth'),
    realm: config.realm,
    sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
    sessionIdleSeconds: config.sessionIdleSeconds,
    rootPrefix: config.rootPrefix,
    logger,
  })

  /** The harness mount as a path fragment: empty at the origin root, else `/main`. */
  const mountPrefix = String(config.rootPrefix).trim().replace(/^\/+|\/+$/gu, '')
  const mount = mountPrefix === '' ? '' : `/${mountPrefix}`

  /**
   * The daemon-owned path a request addresses, with the harness mount stripped.
   *
   * One origin carries two surfaces: this process's own routes (`/admin`,
   * `/api/auth.*`) and the harness, mounted under `config.rootPrefix`. The panel and
   * the login page are served *from* that mount, so a browser resolves their
   * requests against the page it is on and calls `<mount>/admin/…` or
   * `<mount>/api/auth.login`. Those calls name this process's own API — the mount is
   * where its UI is served, not a different authority — so the mount is stripped
   * before the routers see the path.
   *
   * Only `/admin` and `/api/auth.*` are rewritten: everything else under the mount
   * belongs to the harness and is proxied untouched.
   *
   * @param path - the request path, without its query string.
   * @returns the daemon path, or the path unchanged.
   */
  const ownPath = (path) => {
    if (mount === '' || !path.startsWith(`${mount}/`)) return path
    const rest = path.slice(mount.length)
    if (rest === '/admin' || rest.startsWith('/admin/')) return rest
    // The auth endpoints are matched as exact strings by the auth layer, so the
    // login form posts inside the mount and the mount is stripped here.
    if (rest === '/api/auth.login' || rest === '/api/auth.logout' || rest === '/api/auth.state') return rest
    return path
  }

  /**
   * Answer daemon-owned paths and gate everything else behind a session.
   *
   * The order is the security boundary: authentication endpoints first (they must be
   * reachable without a session), then the session check, then `/admin`. An environment
   * prefix is matched only after this returns false, so it can never shadow these.
   *
   * Requests arriving *from* the tunnel never reach here — they are decoded straight to
   * the proxy. That is why an edge does not ask a main-node user to log in again.
   */
  const local = async (req, res, url) => {
    const secure = isSecure(req)
    // Requests arriving over the tunnel were authenticated when the edge connected, and
    // only the main node can put frames on that connection. Requiring a browser session
    // here would make the main node's own inventory call fail.
    const proof = req.headers['x-dsh-federation']
    if (proof !== undefined && config.token !== '' && proof === config.token) {
      const path = url.split('?')[0]
      // `/admin/file` is the byte surface and everything else under `/admin` is JSON;
      // both sit inside the one prefix, so one branch answers them and one gate protects
      // them.
      if (path === '/admin/file' || path.startsWith('/admin/file')) return await serveFileRoute(req, res, url)
      if (path === '/admin' || path.startsWith('/admin/')) return await admin(req, res, url)
    }
    // The auth layer matches its endpoints as exact strings, and the login page
    // posts from inside the mount, so the mount is stripped before it is asked.
    const authQueryAt = url.indexOf('?')
    const authPath = ownPath(authQueryAt === -1 ? url : url.slice(0, authQueryAt))
    const authUrl = authQueryAt === -1 ? authPath : `${authPath}${url.slice(authQueryAt)}`
    if (await auth.handle(req, res, authUrl, secure)) return true
    if (!loaded) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('daemon: starting\n')
      return true
    }
    const queryAt = url.indexOf('?')
    const path = queryAt === -1 ? url : url.slice(0, queryAt)
    const search = queryAt === -1 ? '' : url.slice(queryAt)
    // The same admin route, addressed through the mount the panel is served from.
    const daemonPath = ownPath(path)
    // The login page's own assets, ahead of the session gate: they are what the page
    // a visitor without a session is served refers to, so gating them would make the
    // browser parse the login HTML as a manifest and fail silently. Both the route and
    // the page's declared href are derived from `config.rootPrefix`.
    if (sendPwaAsset(req, res, path, config.rootPrefix)) return true
    // An environment prefix is not a daemon-owned path: route it instead of gating it.
    // The edge has its own login, and this node has already authenticated whoever is
    // asking before the request got here.
    const routed = path.slice(1).split('/')[0]
    if (routed !== '' && registry.find(routed) !== undefined) return false
    // Kept outside the gate so `/admin` can tell which session is asking: the session
    // overview marks that row `current`, and without it the panel cannot tell the
    // operator's own browser apart from any other. Undefined means nothing
    // authenticated this request — a tunnel-authenticated call is nobody's session.
    let record
    if (sessionRequired(path)) {
      record = auth.session(req, secure, res)
      if (record === undefined) {
        if (path.startsWith('/api/')) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: 'unauthenticated' }))
          return true
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(auth.loginPage(req))
        return true
      }
    }
    if (daemonPath === '/admin' || daemonPath.startsWith('/admin/')) {
      return await admin(req, res, `${daemonPath}${search}`, record?.id)
    }
    return false
  }

  /**
   * The browser-facing session for the root profile.
   *
   * The root profile gates `/` and `/api` on a cookie derived from its own
   * authority, which a browser reaching the daemon can never present. The daemon
   * exchanges the launch token its child printed, caches the cookie, and attaches
   * it upstream. The token is re-read on every child start, so a profile restart
   * cannot leave a stale cookie behind.
   */
  const embeddedRoot = {
    cookie: undefined,
    pending: undefined,
    /** The harness port if the listener is mounted yet, otherwise 0. */
    portOrZero() {
      const carrier = ctx.get('webServer')
      return carrier?.port ?? 0
    },
    /** Loopback port of the harness listener this process runs. */
    port() {
      const carrier = ctx.get('webServer')
      if (carrier === undefined || carrier.port === undefined) {
        throw new Error('daemon: no webServer port; the embedded root needs a mounted harness listener')
      }
      return carrier.port
    },
    /** Mount point the harness is served under, or empty for the origin root. */
    prefix: config.rootPrefix,
    refresh() {
      embeddedRoot.cookie = undefined
    },
    /**
     * Mint the upstream session from this process's own launch token.
     *
     * `connection.authenticatedUrl()` is the documented way to obtain a tokenized
     * URL for a mount proxy; exchanging it once yields the cookie a browser could
     * never present.
     */
    async ensure() {
      if (embeddedRoot.cookie !== undefined) return
      if (embeddedRoot.pending !== undefined) return embeddedRoot.pending
      const connection = ctx.get('connection')
      if (connection === undefined) throw new Error('daemon: no connection service for the embedded root')
      embeddedRoot.pending = (async () => {
        try {
          const base = `http://127.0.0.1:${embeddedRoot.port()}/`
          const tokenized = connection.authenticatedUrl(base)
          const answer = await fetch(tokenized, { redirect: 'manual' })
          const raw = answer.headers.getSetCookie?.() ?? []
          const found = raw
            .map((value) => /^(dsh-auth-[A-Za-z0-9_-]+=[^;]+)/u.exec(value)?.[1])
            .find(Boolean)
          embeddedRoot.cookie = found
          if (found === undefined) logger.warn('daemon: embedded root answered no session cookie')
        } catch (error) {
          logger.warn(`daemon: embedded root session exchange failed: ${error.message}`)
        } finally {
          embeddedRoot.pending = undefined
        }
      })()
      return embeddedRoot.pending
    },
  }

  /** Result of the systemd attempt, reported on the panel. */
  let systemdState = { status: 'not attempted' }

  /**
   * The local profiles this node runs itself.
   *
   * Each `local` environment record names a profile and a port; this table spawns the
   * child, reads the launch token from its stdout, and exchanges that token for the
   * cookie the browser could never present — the same exchange `embeddedRoot` performs
   * for this process's own harness, done once per local environment.
   */
  const localProfiles = createProfileProcesses({
    spawn: (spec) => spawnChild(spec),
    execPath: process.execPath,
    script: process.argv[1],
    dshHome: homeDir,
    cwd: process.cwd(),
    // The Loader validates `config` through `Config`, but a direct caller may pass
    // nothing, so the pool default is applied here too.
    portRange: config.localProfilePortRange ?? [57_000, 57_099],
    readFile: (path) => readFile(path, 'utf8'),
    log: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  })

  /** Cached browser-facing cookie per local environment id. */
  const localCookies = new Map()

  /**
   * Resolve one environment id to a loopback upstream, or undefined when it is not a
   * local environment.
   *
   * The cookie is exchanged lazily and cached until the child is replaced: a restart
   * mints a new launch token, so `refresh()` drops the cache and the next request
   * re-exchanges.
   */
  const localProfileFor = (id) => {
    const environment = registry.find(id)
    if (environment === undefined || environment.kind !== 'local') return undefined
    return {
      port: () => environment.port,
      cookie: () => localCookies.get(id),
      refresh: () => localCookies.delete(id),
      async ensure() {
        const ready = await localProfiles.ensure(environment.profile, environment.port)
        if (localCookies.has(id)) return ready
        // `fetch` follows the daemon's own loopback path; the child's launch URL carries
        // the token that mints the session.
        const answer = await fetch(ready.url, { redirect: 'manual' })
        const raw = answer.headers.getSetCookie?.() ?? []
        const found = raw
          .map((value) => /^(dsh-auth-[A-Za-z0-9_-]+=[^;]+)/u.exec(value)?.[1])
          .find(Boolean)
        if (found === undefined) logger.warn(`daemon: local profile ${id} answered no session cookie`)
        else localCookies.set(id, found)
        return ready
      },
    }
  }


  /**
   * Install a unit for this process when that would help.
   *
   * Three cases, and only the middle one acts:
   *
   * - already under systemd: a unit exists and is running; rewriting it from inside
   *   itself would edit the file systemd is reading
   * - started by hand: nothing brings this back after a reboot, so write and enable one
   * - opted out: the operator said no
   */
  const ensureUnit = async () => {
    if (config.systemdUnit === '') {
      systemdState = { status: 'disabled by configuration' }
      return
    }
    if (underSystemd()) {
      systemdState = { status: 'already managed by systemd' }
      logger.info('daemon: running under systemd; not installing another unit')
      return
    }
    // Fixed, not derived: the unit is *the daemon*. Deriving it from role or port would
    // make the name depend on configuration, so a port change would leave a stale unit
    // behind that still starts on boot.
    const name = unitNameFor()
    try {
      const text = renderUnit({
        name,
        argv: process.argv,
        execPath: process.execPath,
        port: config.port,
        env: process.env,
      })
      const result = await installUnit({ name, text, scope: config.systemdScope })
      systemdState = result.ok
        ? { status: result.changed ? 'installed' : 'already current', unit: result.unit, path: result.path }
        : { status: 'failed', error: result.error, unit: result.unit }
      if (result.ok) {
        logger.info(`daemon: wrote ${result.path} and enabled ${result.unit}; it will start on boot`)
      } else {
        logger.warn(`daemon: could not install a systemd unit: ${result.error}`)
      }
    } catch (error) {
      // A process started in a way a unit cannot describe is not an error worth stopping
      // for, but it is worth saying out loud.
      systemdState = { status: 'failed', error: String(error.message) }
      logger.warn(`daemon: could not describe this process as a unit: ${error.message}`)
    }
  }

  const profileName = config.profile === ''
    ? process.env.DSH_PROFILE ?? 'main'
    : config.profile
  const inventory = () => readInventory({
    homeDir,
    profile: profileName,
    skillsRoot: defaultSkillsRoot(process.env.HOME ?? '/root'),
    // Not `ctx.registry.keys()`: those are fiber keys, not plugin names. The mounted set
    // is the profile's bundles, which `readInventory` already returns.
    plugins: [],
  })

  const patchPath = join(homeDir, 'profiles', profileName, 'cordis.patch.yml')
  const credentialsPath = join(homeDir, '.credentials.yaml')

  /** Read this node's model configuration, summarized for display. */
  const readModel = async () => {
    let patch = ''
    try {
      patch = await readFile(patchPath, 'utf8')
    } catch {
      return summarizeModelRows('', false)
    }
    const rows = extractModelRows(patch)
    const hasKey = await keyPresent(credentialsPath, rows)
    return summarizeModelRows(rows, hasKey)
  }

  /** The model rows verbatim, for pushing to another node. */
  const readModelRows = async () => extractModelRows(await readFile(patchPath, 'utf8'))

  /**
   * Replace this node's model configuration.
   *
   * The existing patch is copied aside first: a model config that stops the harness from
   * booting is a state the operator has to be able to leave, and the only way back is the
   * file that worked.
   */
  const writeModel = async (rows, { syncCredentials = false } = {}) => {
    try {
      const patch = await readFile(patchPath, 'utf8')
      const backup = `${patchPath}.bak-model-${Date.now()}`
      await writeFile(backup, patch, { mode: 0o600 })
      await writeFile(patchPath, replaceModelRows(patch, rows), { mode: 0o600 })
      const written = summarizeModelRows(extractModelRows(rows), await keyPresent(credentialsPath, rows))
      return {
        ok: true,
        model: written,
        backup,
        // Stated rather than implied: a reload is needed for the new provider to take
        // effect, and this deployment cannot reload in place.
        note: 'restart this environment for the new configuration to take effect',
        credentialsSynced: syncCredentials,
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const admin = createAdmin({
    registry,
    hub,
    deliverMessage,
    remoteInfo,
    topologyChanged: () => hub.broadcastTopology(),
    config: { ...config, cacheDir },
    profileSelf: selfInfo,
    inventory,
    readModel,
    readModelRows,
    writeModel,
    // The session view belongs to the auth layer, which owns the records; `/admin` only
    // aggregates it with what the other nodes answer. Wrapped rather than passed by
    // reference so the method keeps its own `this`-free closure contract.
    sessions: (currentId) => auth.sessions(currentId),
    // The change itself belongs to the auth layer for the same reason: it writes the
    // credential file and revokes sessions, and both stores are its own. This router
    // only decides the shape of the request and the words of the refusal.
    changeCredential: (request) => auth.changeCredential(request),
    logger,
  })

  const notFound = (req, res, url) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`daemon: nothing serves ${url}\n`)
  }

  /** Edge role: keep a tunnel to the main node. */
  const agent = config.role === 'edge'
    ? createTunnelAgent({
      mainUrl: config.mainUrl,
      token: config.token,
      harnessPort: () => embeddedRoot.portOrZero(),
      // `/admin` belongs to this process; the tunnel forwards it here, not to the harness.
      daemonPort: () => config.port,
      // The edge's own harness session, minted the same way the main node mints one for
      // its root profile.
      harnessCookie: async () => {
        try {
          await embeddedRoot.ensure()
        } catch (error) {
          logger.warn(`daemon: could not mint the harness session: ${error.message}`)
          return undefined
        }
        logger.info(`daemon: harness cookie state: ${embeddedRoot.cookie === undefined ? 'absent' : 'present'}`)
        return embeddedRoot.cookie
      },
      logger,
    })
    : undefined

  /**
   * The sending half of an agent message.
   *
   * A main node can reach any of its edges; an edge can reach only itself and, through
   * the tunnel, the main node. Both go out through `hub.sendAgentMessage`, which is the
   * same path a frame takes when it arrives from the other direction.
   */
  const sendAgentMessage = async (request) => {
    const toEnvId = String(request.envId ?? '').trim()
    if (toEnvId === '' || toEnvId === 'self') {
      // Local delivery never crosses the tunnel; going out and back would need the main
      // node to be reachable, and on an edge it might not be. The sender is this node,
      // which is exactly what `self` means to a caller here — not a guess at its name.
      return await deliverMessage({
        fromEnvId: 'self',
        fromSessionId: request.fromSessionId,
        sessionId: request.sessionId,
        text: request.text,
      })
    }
    if (config.role !== 'main') {
      // An edge holds exactly one tunnel — to the main node — so it cannot know whether
      // a *peer* edge is online; `hub.isOnline('edgeb')` is false on every edge by
      // construction. The main node answers that question, and its answer comes back as
      // the tool result. Checking locally first made every edge-to-edge message fail
      // with "offline" no matter what.
      return await agent.sendAgentMessage({
        toEnvId,
        fromSessionId: request.fromSessionId,
        sessionId: request.sessionId,
        text: request.text,
      })
    }
    if (!hub.isOnline(toEnvId)) {
      return { ok: false, error: `environment "${toEnvId}" is offline; call agent_list_envs` }
    }
    // The main node holds every edge's tunnel, so it can send directly.
    return await hub.sendAgentMessage(toEnvId, {
      fromEnvId: 'self',
      fromSessionId: request.fromSessionId,
      sessionId: request.sessionId,
      text: request.text,
    })
  }

  /** The environment list the agent sees: this node plus every tunnel it can use. */
  const listReachable = async () => {
    const rows = [{
      envId: 'self',
      label: config.role === 'main' ? 'this node (main)' : 'this node (edge)',
      online: true,
    }]
    if (config.role === 'main') {
      for (const environment of registry.list()) {
        rows.push({
          envId: environment.id,
          label: environment.label,
          online: hub.isOnline(environment.id),
        })
      }
      return rows
    }
    // An edge's own registry is empty: environments are the main node's to know, and an
    // edge has no tunnel to any of them. Without asking, the tool would answer "just
    // yourself" and the model could never learn a peer's id.
    const answer = await agent.listEnvironments()
    for (const row of answer?.environments ?? []) {
      if (row.envId === 'self') continue
      rows.push({ envId: row.envId, label: row.label, online: row.online })
    }
    return rows
  }

  /**
   * One JSON request into a peer's daemon-owned routes, from the main node.
   *
   * The main node holds every edge's tunnel; `hub.relayOverTunnel` is the same writer the
   * agent-message path uses.
   */
  const requestOverTunnel = (envId, method, path, body) => hub.relayOverTunnel(envId, { method, path, body })

  /**
   * Ask one environment for its workspace table.
   *
   * Local reads answer from this node's own services; a peer is asked over its tunnel
   * through the same `/admin` surface every other cross-node call uses.
   *
   * @param envId - target environment; empty means this node.
   * @returns `{ ok, workspaces?, error? }`.
   */
  const readWorkspacesOf = async (envId) => {
    if (envId === '' || envId === 'self') {
      return listWorkspaces({ workspaces: remoteInfo.workspaces })
    }
    if (config.role !== 'main') return await agent.readRemote(envId, 'GET', '/admin/workspaces')
    return await requestOverTunnel(envId, 'GET', '/admin/workspaces')
  }

  /**
   * Ask one environment for the sessions in one workspace.
   *
   * @param envId - target environment; empty means this node.
   * @param workspaceId - workspace to narrow to; empty means every workspace.
   * @returns `{ ok, sessions?, error? }`.
   */
  const readSessionsOf = async (envId, workspaceId) => {
    const suffix = workspaceId === '' ? '' : `?workspaceId=${encodeURIComponent(workspaceId)}`
    if (envId === '' || envId === 'self') {
      return await listSessions({ workspaces: remoteInfo.workspaces, sessions: remoteInfo.sessions }, workspaceId)
    }
    if (config.role !== 'main') return await agent.readRemote(envId, 'GET', `/admin/remote-sessions${suffix}`)
    return await requestOverTunnel(envId, 'GET', `/admin/remote-sessions${suffix}`)
  }

  /**
   * Copy one file to an environment.
   *
   * Local writes go straight to disk; a peer receives the chunks on its own admin route
   * and writes them there. The 32 MiB policy cap is checked on both sides.
   *
   * @param request - `{ path, envId, sourcePath, chunks, overwrite }`.
   * @returns `{ ok, path?, bytes?, error? }`.
   */
  /**
   * Read a local file into the sink, honouring the same `Range` shape as the route.
   *
   * @param path - absolute path.
   * @param write - receives each piece.
   * @param headers - `{ range }` when only a window is wanted.
   * @returns `{ ok, size?, error? }`.
   */
  const streamLocalFile = async (path, write, headers) => {
    const checked = validateDestination(path)
    if (checked.ok !== true) return { ok: false, error: checked.error }
    const info = await stat(checked.path).catch((error) => ({ error }))
    if (info?.error !== undefined) return { ok: false, error: `could not read "${checked.path}": ${info.error.message}` }
    if (!info.isFile()) return { ok: false, error: `not a regular file: "${checked.path}"` }
    let start = 0
    let end = info.size - 1
    const range = headers.range
    if (typeof range === 'string') {
      const m = /^bytes=(\d+)-(\d*)$/u.exec(range)
      if (m !== null) {
        start = Number(m[1])
        if (m[2] !== '') end = Math.min(Number(m[2]), info.size - 1)
      }
    }
    if (start > end) return { ok: false, error: `range ${range} is outside "${checked.path}"` }
    await new Promise((done, fail) => {
      createReadStream(checked.path, { start, end })
        .on('data', (piece) => write(piece))
        .on('error', fail)
        .on('end', done)
    }).catch((error) => ({ error }))
    return { ok: true, size: info.size }
  }

  /** Split collected pieces into the base64 chunks the tool's no-destination form returns. */
  const byteChunks = (pieces) => {
    const bytes = Buffer.concat(pieces)
    const out = []
    for (let at = 0; at < bytes.length; at += 512 * 1024) {
      out.push(bytes.subarray(at, at + 512 * 1024).toString('base64'))
    }
    return out
  }

  /**
   * Pull a file from one environment into this machine.
   *
   * The direction is deliberate. Pushing writes into a machine the sender does not own,
   * where a wrong path or an unexpected overwrite is somebody else's problem and nobody
   * is watching. Pulling writes only here: the caller already has the right to run code
   * on this node, so the consequence stays with whoever asked.
   *
   * The source is read one chunk per round trip, so no single message can exceed the
   * 8 MiB frame cap however large the file is.
   *
   * @param request - `{ path, envId, toPath, overwrite }`.
   * @returns `{ ok, name?, size?, path?, chunks?, error? }`.
   */
  /**
   * Pull a file from one environment into this machine.
   *
   * One HTTP request, one streamed response. The chunk protocol this replaced existed
   * because a frame is capped at 8 MiB; but the tunnel already streams body pieces, so
   * slicing the file and paying a round trip per slice was self-inflicted — measured at
   * roughly 12 ms per 512 KiB chunk end to end.
   *
   * @param request - `{ path, envId, toPath, toOffset, offset, length, overwrite }`.
   * @returns `{ ok, name?, size?, path?, bytes?, error? }`.
   */
  const getFile = async (request) => {
    const source = String(request.envId ?? '').trim()
    const remote = source !== '' && source !== 'self'

    // `Range` is the same mechanism every HTTP client uses, so an offset needs no
    // custom framing.
    const range = request.offset === undefined && request.length === undefined
      ? undefined
      : `bytes=${request.offset ?? 0}-${request.length === undefined
        ? ''
        : String((request.offset ?? 0) + request.length - 1)}`

    const sink = request.toPath === ''
      ? undefined
      : await openStreamSink({ path: request.toPath, overwrite: request.overwrite === true, toOffset: request.toOffset ?? 0 })
    if (sink !== undefined && sink.ok !== true) return sink

    const collect = []
    let bytes = 0
    const sinkWrite = sink === undefined || sink.ok !== true
      ? (piece) => { bytes += piece.length; collect.push(piece) }
      : (piece) => { bytes += piece.length; sink.write(piece) }
    const write = sinkWrite

    let answer
    if (!remote) {
      // Local: read the file here, no tunnel involved.
      const headers = range === undefined ? {} : { range }
      answer = await streamLocalFile(request.path, write, headers)
    } else if (config.role === 'main') {
      answer = await hub.streamFileFromTunnel(source, request.path, write, { range })
    } else {
      answer = await agent.streamFileFromPeer(source, request.path, write, range)
    }

    if (answer.ok !== true) {
      if (sink !== undefined && sink.ok === true) await sink.finish().catch(() => {})
      return { ok: false, error: answer.error }
    }

    if (sink === undefined) {
      return {
        ok: true,
        size: answer.size ?? bytes,
        offset: request.offset ?? 0,
        length: bytes,
        chunks: byteChunks(collect),
      }
    }
    const finished = await sink.finish()
    return finished
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      for (const definition of agentMessageTools({
        listEnvironments: listReachable,
        send: sendAgentMessage,
        listWorkspaces: readWorkspacesOf,
        listSessions: readSessionsOf,
        getFile,
      })) {
        toolCtx.tools.register(definition)
      }
    })
  }

  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      try {
        environments = await readRegistry(registryPath)
      } catch (error) {
        logger.warn(`daemon: registry unavailable: ${error.message}`)
        environments = []
      }
      loaded = true
      logger.info(`daemon: ${environments.length} environment(s) registered (role ${config.role})`)
      if (cancelled) return

      if (config.role === 'edge') {
        if (config.mainUrl === '' || config.token === '') {
          logger.warn('daemon: role is "edge" but mainUrl or token is empty; no tunnel will be opened')
        } else {
          agent.start()
        }
      }

      entry = await startEntry({
        host: config.host,
        port: config.port,
        listEnvironments: () => registry.list().map((one) => ({ id: one.id, online: hub.isOnline(one.id) })),
        local,
        root: config.rootEmbedded
          ? {
            port: embeddedRoot.port,
            prefix: embeddedRoot.prefix,
            cookie: () => embeddedRoot.cookie,
            ensure: embeddedRoot.ensure,
            refresh: embeddedRoot.refresh,
          }
          : undefined,
        tunnel: { path: TUNNEL_PATH, server: tunnelServer, tokenOf, hub },
        localProfile: localProfileFor,
        notFound,
      })
      logger.info(`daemon: listening on ${config.host}:${entry.port}`)

      // Only now: the unit names the ports, and a process that failed to bind would have
      // its failure written into a unit that then cannot start either.
      if (!cancelled) await ensureUnit()
    })().catch((error) => logger.warn(`daemon: entry failed: ${error.message}`))

    return async () => {
      cancelled = true
      agent?.stop()
      hub.close()
      await entry?.close()
      entry = undefined
      // A child outliving the daemon would keep its port and its half of one session
      // registry alive with nobody routing to it.
      await localProfiles.stopAll()
    }
  })
}

/**
 * Whether the key a model configuration references actually exists.
 *
 * Checked without ever reading the value: the panel needs to say 'this environment has no
 * key' so a remote failure is attributable, and a secret has no business crossing that
 * boundary.
 */
async function keyPresent(credentialsPath, rows) {
  const name = /^\s*apiKeyEnv:\s*(\S+)$/mu.exec(rows)?.[1]?.replace(/^['"]|['"]$/gu, '')
  if (name === undefined || name === '') return false
  try {
    const text = await readFile(credentialsPath, 'utf8')
    return new RegExp(`^\\s+${name}:\\s*\\S`, 'mu').test(text)
  } catch {
    return false
  }
}

/** Paths reachable without a session: the login exchange itself. */
function sessionRequired(path) {
  if (path.startsWith('/api/auth.')) return false
  return true
}

function isSecure(req) {
  if (req.socket.encrypted === true) return true
  const forwarded = req.headers['x-forwarded-proto']
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https'
}

async function readRegistry(path) {
  try {
    const text = await readFile(path, 'utf8')
    return parseRegistry(JSON.parse(text))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeRegistry(path, environments) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  // 0600: every record carries the token that authenticates that edge.
  await writeFile(temporary, serializeRegistry(environments), { mode: 0o600 })
  await rename(temporary, path)
}
