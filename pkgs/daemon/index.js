/**
 * daemon: one entry, many profiles.
 *
 * This Host plugin owns the deployment's only public listener. It authenticates a
 * browser once, then routes `/<id>/…` to the profile process serving that id.
 * Profiles are ordinary `dsh --profile <name>` processes on loopback ports; a
 * remote profile keeps its process here and moves only the filesystem,
 * subprocess and sandbox providers to the SSH host.
 *
 * Nothing here needs the harness's own `webServer` service, so swapping the web
 * plugin cannot disable the entry.
 *
 * @module @yiln-dsh/dsh-daemon
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createAdmin } from './lib/admin.js'
import {
  ensureSshInclude,
  generateKey,
  removeSshFragment,
  resolveHost,
  scanHostKey,
  trustHostKey,
  writeSshFragment,
  writeUninstallScript,
} from './lib/credentials.js'
import { createAuth } from './lib/auth/gateway.js'
import { startEntry } from './lib/entry.js'
import { renderPortal } from './lib/portal.js'
import { profileDependencies, writeProfile } from './lib/provision.js'
import {
  allocatePort,
  deriveId,
  normalizeProfile,
  parseRegistry,
  RESERVED_IDS,
  serializeRegistry,
} from './lib/registry.js'
import { createSshOps } from './lib/ssh.js'
import { createSupervisor, probePort } from './lib/supervisor.js'

/** Stable Cordis plugin name. */
export const name = 'daemon'

/**
 * No declared injection: the entry, the supervisor and the registry all work
 * without any other plugin, and declaring `webServer` would make the daemon
 * unable to start in a deployment that runs a different web surface.
 */
export const inject = []

export const Config = z.object({
  /** Bind address of the public listener. `0.0.0.0` is intentional here. */
  host: z.string().default('0.0.0.0'),
  /** Bind port of the public listener. */
  port: z.natural().max(65535).default(3080),
  /**
   * The operator's ssh config. One `Include` line is added there pointing at the
   * fragment directory, because `dsh-ssh` passes no identity or port flags — ssh can
   * only learn them from its own configuration.
   */
  sshConfigPath: z.string().default(''),
  /** First loopback port offered to a managed environment. */
  portBase: z.natural().max(65535).default(56789),
  /** Registry JSON path. */
  registryPath: z.string().default(''),
  /** `$DSH_HOME`, handed to every profile process. */
  homeDir: z.string().default(''),
  /** Directory holding cached helper artifacts. */
  cacheDir: z.string().default(''),
  /** Version stamped into helper artifact names and digests. */
  helperVersion: z.string().default('0.2.1-rc.2'),
  /** Download template with `<version>` and `<arch>` placeholders; empty disables it. */
  helperDownloadUrl: z.string().default(''),
  /** `dsh` executable used to spawn profiles. */
  binPath: z.string().default('dsh'),
  /** `pnpm` executable used to install a new profile's dependencies. */
  pnpmPath: z.string().default('pnpm'),
  /** Bundle layers every generated profile mounts. */
  profileBundles: z.array(z.string()).default([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@local/yiln-agent-preset',
  ]),
  /** Harness version pinned into a generated profile; empty skips the pins. */
  harnessVersion: z.string().default('0.2.1-rc.2'),
  /**
   * Absolute path to a YAML fragment appended to every generated profile patch.
   *
   * Model routing and preset defaults are deployment facts; keeping them in a
   * fragment means swapping a provider never needs a code change here.
   */
  profilePatchPath: z.string().default(''),
  /**
   * Serve the harness this process runs, mounted under this prefix, for paths no
   * profile claims. The embedded root needs no child process: its session is
   * minted from this process's own launch token through the documented
   * `connection.authenticatedUrl()` API.
   */
  rootEmbedded: z.boolean().default(false),
  /** Mount point of the embedded root, e.g. `main`. Empty serves it at `/`. */
  rootPrefix: z.string().default(''),
  /**
   * Id of the profile that answers paths no prefix claims, so the existing origin
   * keeps working unchanged. Empty means the daemon owns `/` and shows its portal.
   *
   * The daemon spawns this profile itself, which is what makes the arrangement
   * possible: `dsh web` prints a launch token that rotates on every start, and
   * the daemon has to read the current one from the child it supervises.
   */
  rootProfile: z.string().default(''),
  /** Start enabled profiles when the daemon boots. */
  autostart: z.boolean().default(true),
  /** Seconds a profile may take to answer its port after spawn. */
  readyMs: z.natural().default(90_000),
  /** Realm shown on the login page. */
  realm: z.string().default('DeepSeek Harness'),
  /** The single accepted user name. */
  username: z.string().default('admin'),
  /** The accepted password; empty disables password login. */
  password: z.string().default(''),
  /** Require a TOTP code in addition to the password. */
  twoFactorEnabled: z.boolean().default(false),
  /** Base32 TOTP secret; required when two-factor is enabled. */
  totpSecret: z.string().default(''),
  /**
   * WebAuthn origin, e.g. `https://dsh.example.com`. Empty derives it from the
   * request, which is wrong behind a TLS-terminating proxy.
   */
  passkeyOrigin: z.string().default(''),
  /** WebAuthn RP ID. Empty follows the resolved origin's hostname. */
  passkeyRpId: z.string().default(''),
  /** Absolute session lifetime. */
  sessionMaxAgeSeconds: z.natural().default(2_592_000),
  /** Idle timeout. */
  sessionIdleSeconds: z.natural().default(604_800),
  /**
   * Address a browser uses for a profile, with `<id>` substituted; empty leaves
   * the profile advertising its own loopback origin.
   */
  publicUrl: z.string().default(''),
})

/**
 * Attach the daemon.
 *
 * @param ctx - the Cordis context.
 * @param config - resolved configuration.
 */
export function apply(ctx, config) {
  const homeDir = resolve(config.homeDir === '' ? process.env.DSH_HOME ?? '/root/.dsh' : config.homeDir)
  const registryPath = resolve(
    config.registryPath === '' ? join(homeDir, 'daemon', 'profiles.json') : config.registryPath,
  )
  const cacheDir = resolve(config.cacheDir === '' ? join(homeDir, 'daemon', 'cache') : config.cacheDir)
  const daemonDir = resolve(join(homeDir, 'daemon'))
  const keysRoot = join(daemonDir, 'keys')
  const sshConfigDir = join(daemonDir, 'ssh_config.d')
  const profileDir = (profile) => join(homeDir, 'profiles', profile)

  let profiles = []
  let loaded = false
  let entry
  const pending = new Set()

  const logger = {
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger?.warn?.(message),
    debug: (message) => ctx.logger?.debug?.(message),
  }

  const registry = {
    list: () => [...profiles],
    find: (id) => profiles.find((profile) => profile.id === id),
    /**
     * Replace one environment's editable fields.
     *
     * @param id - the environment id.
     * @param patch - fields to merge; validated as a whole record afterwards.
     * @returns the updated environment.
     */
    async update(id, patch) {
      const current = profiles.find((entry) => entry.id === id)
      if (current === undefined) throw new Error(`daemon: unknown environment "${id}"`)
      const next = normalizeProfile({ ...current, ...patch })
      profiles = profiles.map((entry) => (entry.id === id ? next : entry))
      await registry.save()
      return next
    },
    usedPorts: () => new Set(profiles.map((profile) => profile.port)),
    usedIds: () => new Set(profiles.map((profile) => profile.id)),
    async reload() {
      profiles = await readRegistry(registryPath)
      loaded = true
    },
    async save() {
      await writeRegistry(registryPath, profiles)
    },
  }

  const supervisor = createSupervisor({
    binPath: config.binPath,
    profileDir,
    homeDir,
    readyMs: config.readyMs,
    onExit: (id, code, signal) => logger.warn(`daemon: profile "${id}" exited (code ${code}, signal ${signal})`),
    publicUrl: config.publicUrl === '' ? undefined : (profile) => config.publicUrl.replaceAll('<id>', profile.id),
  })

  /** Read the operator's patch fragment, or an empty string when unset. */
  const readFragment = async () => {
    if (config.profilePatchPath === '') return ''
    try {
      return await readFile(config.profilePatchPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`daemon: profilePatchPath ${config.profilePatchPath} does not exist`)
      throw error
    }
  }

  const provision = {
    /**
     * Register one environment: allocate a port, write the profile and record it.
     *
     * The credential must already exist; this step only materializes the profile.
     *
     * @param input - the resolved environment fields.
     * @returns the registered environment.
     */
    async createEnvironment(input) {
      const id = input.id
      const draft = {
        id,
        label: input.label ?? id,
        profile: `daemon-${id}`,
        port: allocatePort(config.portBase, registry.usedPorts()),
        workspace: input.workspace ?? '/root/workspace',
        enabled: input.enabled === undefined ? true : input.enabled !== false,
        sshHost: input.sshHost,
        sshUser: input.sshUser,
        sshHelper: input.sshHelper,
        sshHelperHash: input.sshHelperHash,
        sshKeyPath: input.sshKeyPath,
        ...(input.sshPort === undefined ? {} : { sshPort: Number(input.sshPort) }),
      }
      const profile = normalizeProfile(draft)
      await writeSshFragment({ sshConfigDir, alias: input.alias ?? `dsh-${id}`, entry: profile })
      await writeProfile(profileDir(profile.profile), profile, {
        bundles: config.profileBundles,
        dependencies: profileDependencies(config.profileBundles, {
          agentPresetsDir: join(homeDir, '.agent-presets'),
          harnessVersion: config.harnessVersion === '' ? undefined : config.harnessVersion,
        }),
        fragment: await readFragment(),
      })
      await installDependencies(profileDir(profile.profile), config.pnpmPath, homeDir)
      profiles = [...profiles, profile]
      await registry.save()
      logger.info(`daemon: created environment "${profile.id}" on port ${profile.port}`)
      return profile
    },

    /**
     * First onboarding phase: identify the host, write nothing.
     *
     * The operator's credential is used once and never stored. The host key is only
     * scanned, not trusted — the fingerprint goes back for the operator to compare
     * against what the machine reports.
     *
     * @param input - `{ sshHost, sshPort?, sshUser, password? }`, or an existing id to
     *   re-identify while editing credentials.
     * @returns host facts, the scanned fingerprint and the planned id.
     */
    async prepare(input) {
      const sshHost = requireField(input, 'sshHost')
      const sshUser = requireField(input, 'sshUser')
      const sshPort = input.sshPort === undefined ? undefined : Number(input.sshPort)
      const facts = await ssh.probe({ sshHost, sshPort, sshUser, password: input.password, identityFile: input.identityFile })
      // Resolve once here: the ssh fragment needs the real address, and the operator
      // may have typed an ssh_config alias.
      const resolved = await resolveHost(sshHost, sshPort)
      const { fingerprint } = await scanHostKey({ host: sshHost, port: sshPort })
      const existing = typeof input.id === 'string' && input.id !== '' ? registry.find(input.id) : undefined
      const id = existing?.id ?? deriveId(input.id ?? sshHost, new Set([...registry.usedIds(), ...RESERVED_IDS]))
      return { id, fingerprint, host: facts, alias: `dsh-${id}` }
    },

    /**
     * Second onboarding phase: perform every write.
     *
     * Host key trust, key generation, public key install, helper deployment and
     * profile creation happen here, in that order: the key must be installed before
     * the helper upload, because `dsh-ssh` runs ssh with `BatchMode=yes` and needs a
     * working credential for the rest of the environment's life.
     *
     * @param input - the fields from `prepare` plus `fingerprint` and `sshHelperHash`.
     * @returns the created environment.
     */
    async confirm(input) {
      const prepared = await provision.prepare(input)
      const sshHost = requireField(input, 'sshHost')
      const sshUser = requireField(input, 'sshUser')
      const sshPort = input.sshPort === undefined ? undefined : Number(input.sshPort)
      const sshHelper = input.sshHelper ?? '/opt/dsh-helper/dsh-ssh-helper'
      const id = prepared.id
      const resolved = await resolveHost(sshHost, sshPort)

      const clash = profiles.find((entry) => entry.sshHost === sshHost && entry.sshHelper === sshHelper && entry.id !== id)
      if (clash !== undefined) {
        throw new Error(`daemon: helper ${sshHelper} on ${sshHost} is already used by environment "${clash.id}"`)
      }

      await ensureSshInclude({ configPath: sshConfigPath, includeDir: sshConfigDir })
      await trustHostKey({
        knownHostsPath: join(process.env.HOME ?? '/root', '.ssh', 'known_hosts'),
        host: resolved.host,
        port: resolved.port,
        expectedFingerprint: input.fingerprint,
      })

      const key = await generateKey({ keysRoot, id })
      const alias = `dsh-${id}`
      await ssh.installPublicKey({
        sshHost: resolved.host,
        sshPort: resolved.port,
        sshUser,
        password: input.password,
        identityFile: input.identityFile,
        publicKey: key.publicKey,
        id,
      })
      const profile = await provision.createEnvironment({
        id,
        label: input.label ?? id,
        // The resolved address: an alias written into HostName would be re-resolved by
        // ssh as a hostname.
        sshHost: resolved.host,
        // The resolved port, not the operator's input: it may have come from an alias.
        sshPort: resolved.port,
        sshUser,
        sshHelper,
        sshHelperHash: input.sshHelperHash,
        sshKeyPath: key.keyPath,
        workspace: input.workspace,
        enabled: input.enabled,
        alias,
      })
      // The helper upload runs over the alias just written, so it needs no password.
      try {
        const deployed = await ssh.deploy(profile)
        if (deployed.sha256 !== profile.sshHelperHash) {
          await registry.update(id, { sshHelperHash: deployed.sha256 })
        }
      } catch (error) {
        // The environment exists and the operator can retry from the panel; failing the
        // whole onboarding here would force re-entering the bootstrap credential.
        logger.warn(`daemon: environment "${id}" created, helper deploy failed: ${error.message}`)
      }
      return registry.find(id) ?? profile
    },

    /**
     * Create one profile: allocate an id and port, write the directory, install
     * its dependencies, and register it.
     */
    async create(input) {
      return provision.confirm(input)
    },

    /** Start one profile and wait for its listener. */
    async start(id) {
      const profile = registry.find(id)
      if (profile === undefined) throw new Error(`daemon: unknown profile "${id}"`)
      return supervisor.start(profile)
    },

    /**
     * Stop and forget one environment.
     *
     * Local artifacts always go — the key and the ssh fragment are that
     * environment's alone. The remote helper is a file on someone else's machine, so
     * it is removed only when explicitly asked; a script is always written so the
     * operator can do it later by hand. `known_hosts` is never touched: it records the
     * machine's identity, not this environment's.
     *
     * @param id - the environment id.
     * @param options.removeRemoteHelper - also delete the helper on the remote host.
     * @returns the uninstall script path and whether the remote helper was removed.
     */
    async remove(id, { removeRemoteHelper = false } = {}) {
      const profile = registry.find(id)
      if (profile === undefined) throw new Error(`daemon: unknown environment "${id}"`)
      await supervisor.stop(id)
      const scriptPath = await writeUninstallScript({ daemonDir, entry: profile, sshConfigPath })
      let remoteRemoved = false
      if (removeRemoteHelper) {
        // A failed cleanup must not block forgetting the environment: the operator can
        // still run the script.
        try {
          await ssh.removeRemoteHelper(profile)
          remoteRemoved = true
        } catch (error) {
          logger.warn(`daemon: could not remove the remote helper for "${id}": ${error.message}`)
        }
      }
      await removeSshFragment({ sshConfigDir, id })
      await rm(join(keysRoot, id), { recursive: true, force: true })
      profiles = profiles.filter((candidate) => candidate.id !== id)
      await registry.save()
      logger.info(`daemon: removed environment "${profile.id}"`)
      return { uninstallScript: scriptPath, remoteRemoved }
    },
  }

  const sshConfigPath = config.sshConfigPath === ''
    ? join(process.env.HOME ?? '/root', '.ssh', 'config')
    : config.sshConfigPath
  const ssh = createSshOps({
    config: { ...config, cacheDir, helperVersion: config.helperVersion },
    logger,
  })
  const admin = createAdmin({ registry, supervisor, provision, ssh, config: { ...config, cacheDir } })

  const password = config.password !== ''
    ? config.password
    : process.env.DSH_AUTH_PASS ?? process.env.AUTH_PASS ?? ''
  // The same fallback chain the retired gateway used, so an existing deployment
  // keeps the credentials it already has.
  const username = config.username !== 'admin'
    ? config.username
    : process.env.DSH_AUTH_USER ?? process.env.AUTH_USER ?? config.username
  if (password === '') {
    // `Boolean('')` is false, so an empty password rejects every login attempt.
    // Silently serving an unpassable login page is how a deployment locks itself
    // out; say so once, at startup, and keep serving.
    logger.warn('daemon: no password configured (config.password or DSH_AUTH_PASS); the login page will reject every attempt')
  }
  const auth = createAuth({
    directory: join(homeDir, 'daemon', 'auth'),
    username,
    password,
    realm: config.realm,
    twoFactorEnabled: config.twoFactorEnabled,
    totpSecret: config.totpSecret,
    sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
    sessionIdleSeconds: config.sessionIdleSeconds,
    passkeyOrigin: config.passkeyOrigin,
    passkeyRpId: config.passkeyRpId,
    logger,
  })

  /**
   * Answer daemon-owned paths and gate everything else behind a session.
   *
   * The order is the security boundary: authentication endpoints first (they must
   * be reachable without a session), then the session check, then `/admin` and
   * the portal. A profile prefix can never shadow these because it is matched
   * only after this returns false.
   */
  const local = async (req, res, url) => {
    const secure = isSecure(req)
    if (await auth.handle(req, res, url, secure)) return true
    if (!loaded) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('daemon: starting\n')
      return true
    }
    const path = url.split('?')[0]
    if (sessionRequired(path)) {
      const record = auth.session(req, secure)
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
    if (path === '/admin' || path.startsWith('/admin/')) {
      return await admin(req, res, url)
    }
    const ownsRoot = config.rootProfile === '' && !config.rootEmbedded
    if (path === '/portal' || (ownsRoot && (path === '/' || path === '/index.html'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        renderPortal({
          profiles,
          running: new Set(supervisor.ids()),
          urls: new Map(supervisor.ids().map((id) => [id, supervisor.url(id)])),
          acceptLanguage: req.headers['accept-language'],
        }),
      )
      return true
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

  const rootBridge = {
    cookie: undefined,
    /** Launch URL the cached cookie was minted from. */
    mintedFrom: undefined,
    pending: undefined,
    port() {
      const profile = registry.find(config.rootProfile)
      if (profile === undefined) throw new Error(`daemon: root profile "${config.rootProfile}" is not registered`)
      return profile.port
    },
    refresh() {
      rootBridge.cookie = undefined
      rootBridge.mintedFrom = undefined
    },
    async ensure() {
      const url = supervisor.url(config.rootProfile)
      if (url === undefined) throw new Error('daemon: root profile is not running')
      // A restart replaces the token, so a cookie minted from the old one is void.
      if (rootBridge.cookie !== undefined && rootBridge.mintedFrom === url) return
      if (rootBridge.pending !== undefined) return rootBridge.pending
      rootBridge.pending = (async () => {
        try {
          const answer = await fetch(url, { redirect: 'manual' })
          const raw = answer.headers.getSetCookie?.() ?? []
          const found = raw
            .map((value) => /^(dsh-auth-[A-Za-z0-9_-]+=[^;]+)/u.exec(value)?.[1])
            .find(Boolean)
          rootBridge.cookie = found
          rootBridge.mintedFrom = url
          if (found === undefined) logger.warn('daemon: root profile answered no session cookie')
        } catch (error) {
          logger.warn(`daemon: root session exchange failed: ${error.message}`)
        } finally {
          rootBridge.pending = undefined
        }
      })()
      return rootBridge.pending
    },
  }

  const notFound = (req, res, url) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`daemon: no profile serves ${url}\n`)
  }

  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      try {
        profiles = await readRegistry(registryPath)
        loaded = true
        logger.info(`daemon: ${profiles.length} profile(s) registered`)
      } catch (error) {
        logger.warn(`daemon: registry unavailable: ${error.message}`)
        loaded = true
      }
      if (cancelled) return

      entry = await startEntry({
        host: config.host,
        port: config.port,
        listProfiles: () => supervisor.ids().map((id) => ({ id, port: registry.find(id)?.port ?? 0 })).filter((row) => row.port !== 0),
        local,
        root: config.rootEmbedded
          ? { port: embeddedRoot.port, prefix: embeddedRoot.prefix, cookie: () => embeddedRoot.cookie, ensure: embeddedRoot.ensure, refresh: embeddedRoot.refresh }
          : config.rootProfile === ''
            ? undefined
            : { port: rootBridge.port, prefix: '', cookie: () => rootBridge.cookie, ensure: rootBridge.ensure, refresh: rootBridge.refresh },
        notFound,
      })
      logger.info(`daemon: listening on ${config.host}:${entry.port}`)

      if (config.autostart) {
        for (const profile of profiles) {
          if (!profile.enabled) continue
          if (cancelled) return
          // Starting a profile is a child process; it must never block activation.
          pending.add(profile.id)
          void provision
            .start(profile.id)
            .then((result) => logger.info(`daemon: profile "${profile.id}" ready on ${result.port}`))
            .catch((error) => logger.warn(`daemon: profile "${profile.id}" failed to start: ${error.message}`))
            .finally(() => pending.delete(profile.id))
        }
      }
    })().catch((error) => logger.warn(`daemon: entry failed: ${error.message}`))

    return async () => {
      cancelled = true
      await supervisor.stopAll()
      await entry?.close()
      entry = undefined
    }
  })
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

function requireField(input, key) {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`daemon: ${key} is required for an SSH profile`)
  }
  return value
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

async function writeRegistry(path, profiles) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(serializeRegistry(profiles), null, 2)}\n`)
  await rename(temporary, path)
}

/**
 * Install a generated profile's dependencies.
 *
 * A profile that mounts the deployment preset cannot start without its packages,
 * and the failure mode is a listener that comes up with every preset marked
 * broken — so the install is part of creating, not an operator follow-up.
 */
function installDependencies(dir, pnpmPath, homeDir) {
  return new Promise((done, fail) => {
    const child = spawn(pnpmPath, ['install', '--ignore-scripts'], {
      cwd: dir,
      env: { ...process.env, DSH_HOME: homeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk.toString()
      if (output.length > 16_000) output = output.slice(-8_000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', fail)
    child.once('exit', (code) => {
      if (code === 0) done()
      else fail(new Error(`daemon: pnpm install failed in ${dir} (exit ${code})\n${output.trim()}`))
    })
  })
}
