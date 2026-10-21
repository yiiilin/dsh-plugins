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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createAdmin } from './lib/admin.js'
import { createAuth } from './lib/auth/session.js'
import { sendPwaAsset } from './lib/auth/pwa.js'
import { startEntry } from './lib/entry.js'
import { createTunnelAgent } from './lib/federation/agent.js'
import { createTunnelHub, createTunnelServer, tokenOf, TUNNEL_PATH } from './lib/federation/hub.js'
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

  /** `main` accepts tunnels; `edge` dials out. Same install either way. */
  role: z.union([z.const('main'), z.const('edge')]).default('main'),

  /** Base URL of the main node. Required when `role` is `edge`. */
  mainUrl: z.string().default(''),
  /** This environment's token. Required when `role` is `edge`. */
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
})

export function apply(ctx, config) {
  const processStartMs = Date.now() - Math.round(process.uptime() * 1000)
  const homeDir = resolve(config.homeDir === '' ? process.env.DSH_HOME ?? '/root/.dsh' : config.homeDir)
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

  const hub = createTunnelHub({
    logger,
    verifyToken: (token) => registry.byToken(token),
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
    ...['password', ...retiredEnvironmentKeys].filter((key) => {
      const value = key === 'password' ? config.password : process.env[key]
      return typeof value === 'string' && value !== ''
    }),
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
    if (sessionRequired(path)) {
      const record = auth.session(req, secure, res)
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
      return await admin(req, res, `${daemonPath}${search}`)
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

  // Which profile this process serves decides where its composition lives.
  /** Result of the systemd attempt, reported on the panel. */
  let systemdState = { status: 'not attempted' }

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
    config: { ...config, cacheDir },
    profileSelf: selfInfo,
    inventory,
    readModel,
    readModelRows,
    writeModel,
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
