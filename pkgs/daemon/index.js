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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createAdmin } from './lib/admin.js'
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
  /** First loopback port offered to a profile. */
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
     * Create one profile: allocate an id and port, write the directory, install
     * its dependencies, and register it.
     */
    async create(input) {
      if (typeof input.adopt === 'string' && input.adopt !== '') {
        return provision.adopt({ ...input, profile: input.adopt })
      }
      const id = deriveId(input.id ?? input.sshHost ?? '', new Set([...registry.usedIds(), ...RESERVED_IDS]))
      const port = allocatePort(config.portBase, registry.usedPorts())
      const kind = input.kind === 'ssh' ? 'ssh' : 'local'
      const workspace = input.workspace ?? (kind === 'ssh' ? '/root/workspace' : join(homeDir, 'ws', id))
      const draft = {
        id,
        label: input.label ?? id,
        kind,
        profile: `daemon-${id}`,
        port,
        workspace,
        enabled: true,
        ...(kind === 'ssh'
          ? {
              sshHost: requireField(input, 'sshHost'),
              // Keep an omitted port omitted: an ssh_config alias may already
              // declare one, and an explicit default would override it.
              ...(input.sshPort === undefined ? {} : { sshPort: Number(input.sshPort) }),
              sshUser: requireField(input, 'sshUser'),
              sshHelper: input.sshHelper ?? '/opt/dsh-helper/dsh-ssh-helper',
              sshHelperHash: requireField(input, 'sshHelperHash'),
              ...(input.sshNode === undefined ? {} : { sshNode: input.sshNode }),
            }
          : {}),
      }
      const profile = normalizeProfile(draft)

      await mkdir(profile.workspace, { recursive: true }).catch(() => {})
      await writeProfile(profileDir(profile.profile), profile, {
        bundles: config.profileBundles,
        dependencies: profileDependencies(config.profileBundles, {
          agentPresetsDir: join(homeDir, '.agent-presets'),
          harnessVersion: config.harnessVersion === '' ? undefined : config.harnessVersion,
          kind: profile.kind,
        }),
        fragment: await readFragment(),
      })
      await installDependencies(profileDir(profile.profile), config.pnpmPath, homeDir)

      profiles = [...profiles, profile]
      await registry.save()
      logger.info(`daemon: created profile "${profile.id}" on port ${profile.port}`)
      return profile
    },

    /**
     * Register an existing profile directory.
     *
     * A hand-managed profile carries its own bundles, plugins and persisted
     * settings. Regenerating it would discard them, so adoption only records the
     * coordinates and leaves every file untouched.
     *
     * @param input - `{ id, profile, workspace, port? }`.
     * @returns the registered profile.
     */
    async adopt(input) {
      const profileName = requireField(input, 'profile')
      const directory = profileDir(profileName)
      try {
        await readFile(join(directory, 'package.json'), 'utf8')
      } catch {
        throw new Error(`daemon: no profile manifest at ${directory}`)
      }
      const id = deriveId(input.id ?? profileName, new Set([...registry.usedIds(), ...RESERVED_IDS]))
      const port = input.port === undefined
        ? allocatePort(config.portBase, registry.usedPorts())
        : Number(input.port)
      const profile = normalizeProfile({
        id,
        label: input.label ?? id,
        kind: 'local',
        profile: profileName,
        port,
        workspace: input.workspace ?? join(homeDir, 'ws', id),
        enabled: true,
      })
      profiles = [...profiles, profile]
      await registry.save()
      logger.info(`daemon: adopted existing profile "${profileName}" as "${profile.id}" on port ${profile.port}`)
      return profile
    },

    /** Start one profile and wait for its listener. */
    async start(id) {
      const profile = registry.find(id)
      if (profile === undefined) throw new Error(`daemon: unknown profile "${id}"`)
      return supervisor.start(profile)
    },

    /** Stop and forget one profile. */
    async remove(id) {
      const profile = registry.find(id)
      if (profile === undefined) throw new Error(`daemon: unknown profile "${id}"`)
      await supervisor.stop(id)
      profiles = profiles.filter((candidate) => candidate.id !== id)
      await registry.save()
      logger.info(`daemon: removed profile "${profile.id}"`)
    },
  }

  const ssh = createSshOps({ config: { ...config, cacheDir, helperVersion: config.helperVersion }, logger })
  const admin = createAdmin({ registry, supervisor, provision, ssh, config: { ...config, cacheDir } })

  const auth = createAuth({
    directory: join(homeDir, 'daemon', 'auth'),
    username: config.username,
    password: config.password,
    realm: config.realm,
    twoFactorEnabled: config.twoFactorEnabled,
    totpSecret: config.totpSecret,
    sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
    sessionIdleSeconds: config.sessionIdleSeconds,
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
    if (path === '/' || path === '/portal' || path === '/index.html') {
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
