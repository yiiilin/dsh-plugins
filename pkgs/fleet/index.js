/**
 * Fleet host: one origin, many development boxes.
 *
 * A *box* is one development target — the fleet host itself, or a remote machine
 * reached over SSH. Each box runs as its own `dsh --profile <name>` process,
 * because the filesystem, subprocess and sandbox services are process-wide
 * singletons: a single `ctx.fs` means a single execution world, so one process
 * cannot be two machines.
 *
 * This plugin supplies the three pieces a fleet needs and dsh does not ship:
 *
 * 1. **A path-prefix gateway** serving every box at `/<id>/` on one origin, so
 *    one browser page manages the whole fleet (see `lib/gateway.js` for the
 *    three invariants that make a stock listener work behind it).
 * 2. **Dynamic profiles** — a box is created from the settings API, not by hand
 *    (see `lib/profiles.js`).
 * 3. **Process supervision** — start, stop, restart and health for each box
 *    (see `lib/supervisor.js`), plus a portal page at the gateway root.
 *
 * Deliberately out of scope: cross-box agent messaging. Boxes keep their own
 * `$DSH_HOME` and session stores, so a session always belongs to exactly one
 * execution world and cannot be resumed against the wrong filesystem.
 *
 * @module @yiln-dsh/dsh-fleet
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  allocatePort,
  normalizeBox,
  parseRegistry,
  serializeRegistry,
} from './lib/boxes.js'
import { startGateway } from './lib/gateway.js'
import { renderPortal } from './lib/portal.js'
import {
  boxDependencies,
  DEFAULT_BOX_BUNDLES,
  DEFAULT_PROFILE_BUNDLES,
  readProfilePatch,
  SSH_PROVIDER_PACKAGES,
  writeProfile,
} from './lib/profiles.js'
import { createSupervisor, probePort } from './lib/supervisor.js'

/** Stable Cordis plugin name. */
export const name = 'fleet'

/**
 * No required services.
 *
 * The fleet owns its own HTTP listener and its own child processes, so it keeps
 * working whatever web plugin a deployment installs — or none. The management
 * API binds opportunistically to `webServer` when that service is present, and
 * is simply absent when it is not.
 */
export const inject = []

/** Fleet configuration. */
export const Config = z.object({
  /** Gateway listener port on the fleet host. */
  gatewayPort: z.natural().max(65535).default(8090),
  /** Gateway listener bind address. */
  gatewayHost: z.string().default('127.0.0.1'),
  /** Absolute path to the fleet registry JSON. */
  registryPath: z.string(),
  /** Absolute `$DSH_HOME` shared by every box process. */
  homeDir: z.string().default(join(homedir(), '.dsh')),
  /** The `dsh` executable used to launch boxes. */
  binPath: z.string().default('dsh'),
  /** First port allocated to a new box. */
  portBase: z.natural().max(65535).default(3101),
  /** How long a starting box may take to listen. */
  readyMs: z.natural().default(60000),
  /** Start every enabled box when the fleet host starts. */
  autostart: z.boolean().default(false),
  /**
   * External authority browsers use to reach the gateway, as `host[:port]`.
   *
   * Each box is started with this in `--trusted-host`. Without it the box's
   * Host/Origin fence rejects the gateway's forwarded `Host` and every `/api`
   * call answers `403`, which the UI shows as an endless reconnect. Leave it
   * unset only when boxes are reached at a loopback authority.
   */
  publicAuthority: z.string().default(''),
  /**
   * Bundle layers written into a generated box profile.
   *
   * The default is the shipped web composition. A deployment that has replaced
   * its web plugin points this at its own bundle list, so swapping the web
   * plugin never requires a change here.
   */
  profileBundles: z.array(z.string()).default([...DEFAULT_BOX_BUNDLES]),
  /** Harness version pinned into a generated box profile, or empty to skip. */
  harnessVersion: z.string().default('0.2.1-rc.2'),
  /** Install a box's dependencies before its first launch. */
  bootstrap: z.boolean().default(true),
  /** Absolute `pnpm` executable used by the bootstrap. */
  pnpmPath: z.string().default('pnpm'),
  /**
   * Absolute path to a YAML fragment appended to every generated box patch.
   *
   * Model routing, preset defaults and local tuning are deployment facts. They
   * live in this fragment rather than in this package, so swapping a provider or
   * a web plugin never needs a code change here.
   */
  boxPatchPath: z.string().default(''),
})


/** Registry file defaults when the file does not exist yet. */
const EMPTY_REGISTRY = { version: 1, boxes: [] }

/**
 * Read the registry, treating an absent file as empty.
 *
 * @param path - absolute registry path.
 * @returns the parsed box list.
 */
async function readRegistry(path) {
  try {
    return parseRegistry(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    if (error instanceof SyntaxError) throw new Error(`fleet: ${path} is not valid JSON: ${error.message}`)
    throw error
  }
}

/**
 * Write the registry through a temporary file.
 *
 * A crash mid-write must not leave a truncated registry the next start cannot
 * parse, so the durable name is only ever replaced by a complete rename.
 *
 * @param path - absolute registry path.
 * @param boxes - the complete box list.
 */
async function writeRegistry(path, boxes) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(serializeRegistry(boxes), null, 2)}\n`)
  await rename(temporary, path)
}

/** Attach the fleet plugin. */
export function apply(ctx, config) {
  const registryPath = resolve(config.registryPath)
  const homeDir = resolve(config.homeDir)
  const profileDir = (profile) => join(homeDir, 'profiles', profile)

  /** Read the operator's box patch fragment, or an empty string when unset. */
  const readBoxPatch = async () => {
    if (config.boxPatchPath === '') return ''
    try {
      return await readFile(config.boxPatchPath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`fleet: boxPatchPath ${config.boxPatchPath} does not exist`)
      }
      throw error
    }
  }

  /** Last known boxes; refreshed on every mutation. */
  let boxes = []
  /** Whether the initial registry read has completed. */
  let loaded = false

  const supervisor = createSupervisor({
    binPath: config.binPath,
    profileDir,
    homeDir,
    readyMs: config.readyMs,
    authority: config.publicAuthority,
    onExit: (id, code, signal) => {
      ctx.logger?.info?.('fleet: box %s exited (code=%s signal=%s)', id, code, signal)
    },
  })

  const enabledIds = () => boxes.filter((box) => box.enabled).map((box) => box.id)

  const gateway = startGateway({
    port: config.gatewayPort,
    host: config.gatewayHost,
    resolve: (id) => supervisor.portOf(id),
    listIds: enabledIds,
    portal: (req, res) => {
      const url = (req.url ?? '/').split('?')[0]
      if (url === '/' || url === '/index.html') {
        const body = renderPortal({
          boxes: boxes.filter((box) => box.enabled),
          running: new Set(supervisor.ids()),
          // A running box's launch URL lets the portal link straight into it.
          urls: new Map(supervisor.ids().map((id) => [id, supervisor.url(id)])),
          gatewayPort: config.gatewayPort,
          acceptLanguage: req.headers['accept-language'],
        })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('fleet: not found\n')
    },
  })
  void gateway.catch((error) => ctx.logger?.error?.('fleet: gateway failed: %s', error.message))

  /**
   * Materialize a box profile and start its process.
   *
   * @param box - the normalized box.
   * @returns the readiness result.
   */
  /**
   * Materialize a box profile and install its dependencies.
   *
   * A box that carries a preset cannot start without its packages, and the
   * failure mode is a listener that comes up with every preset marked broken —
   * so the install is part of launching, not an operator follow-up.
   */
  const install = async (box) => {
    const dir = profileDir(box.profile)
    await writeProfile(
      dir,
      box,
      config.profileBundles,
      boxDependencies(config.profileBundles, {
        agentPresetsDir: config.bootstrap ? join(homeDir, '.agent-presets') : undefined,
        harnessVersion: config.harnessVersion === '' ? undefined : config.harnessVersion,
      }),
      await readBoxPatch(),
    )
    if (!config.bootstrap) return
    await new Promise((done, fail) => {
      const child = spawn(config.pnpmPath, ['install', '--ignore-scripts'], {
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
        else fail(new Error(`fleet: pnpm install failed in ${dir} (exit ${code})\n${output.trim()}`))
      })
    })
  }

  const launch = async (box) => {
    await install(box)
    return supervisor.start(box)
  }

  /** Persist and reload the box list. */
  const save = async (next) => {
    boxes = next
    await writeRegistry(registryPath, boxes)
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${JSON.stringify(value)}\n`)
  }

  const authorize = (req) => {
    // The management API is reachable only from the fleet host itself: it starts
    // processes, so exposing it on the LAN would be remote code execution.
    const remote = req.socket?.remoteAddress ?? ''
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  }

  /** The management surface, mounted on the fleet host's own GUI. */
  const routes = [
    {
      kind: 'exact',
      path: '/_dsh/fleet/state',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        json(res, 200, {
          gateway: { port: config.gatewayPort, host: config.gatewayHost },
          boxes: boxes.map((box) => ({
            id: box.id,
            label: box.label,
            kind: box.kind,
            profile: box.profile,
            port: box.port,
            workspace: box.workspace,
            enabled: box.enabled,
            running: supervisor.isRunning(box.id),
            // Present only while running: the token belongs to that process.
            url: supervisor.url(box.id),
          })),
        })
      },
    },
    {
      kind: 'exact',
      path: '/_dsh/fleet/start',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        const box = boxes.find((entry) => entry.id === body.id)
        if (box === undefined) return json(res, 404, { error: `unknown box "${body.id}"` })
        try {
          const result = await launch(box)
          json(res, 200, { id: box.id, port: result.port, url: result.url })
        } catch (error) {
          json(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: '/_dsh/fleet/stop',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        await supervisor.stop(body.id)
        json(res, 200, { id: body.id })
      },
    },
    {
      kind: 'exact',
      path: '/_dsh/fleet/create',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        try {
          const port = body.port ?? allocatePort(boxes.map((box) => box.port), config.portBase)
          const box = normalizeBox({ ...body, port })
          if (boxes.some((entry) => entry.id === box.id)) {
            return json(res, 409, { error: `box "${box.id}" already exists` })
          }
          await save([...boxes, box])
          await writeProfile(
            profileDir(box.profile),
            box,
            config.profileBundles,
            boxDependencies(config.profileBundles, {
              agentPresetsDir: join(homeDir, '.agent-presets'),
              harnessVersion: config.harnessVersion === '' ? undefined : config.harnessVersion,
            }),
            await readBoxPatch(),
          )
          json(res, 201, { id: box.id, port: box.port, profile: box.profile })
        } catch (error) {
          json(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: '/_dsh/fleet/remove',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        await supervisor.stop(body.id)
        await save(boxes.filter((entry) => entry.id !== body.id))
        json(res, 200, { id: body.id })
      },
    },
    {
      kind: 'exact',
      path: '/_dsh/fleet/patch',
      handler: async (req, res) => {
        if (!authorize(req)) return json(res, 403, { error: 'loopback only' })
        const body = await readJsonBody(req)
        const box = boxes.find((entry) => entry.id === body.id)
        if (box === undefined) return json(res, 404, { error: `unknown box "${body.id}"` })
        json(res, 200, { id: box.id, patch: (await readProfilePatch(profileDir(box.profile))) ?? null })
      },
    },
  ]

  // Mount the management API only when a web server service exists. This is a
  // runtime binding rather than a declared injection: the fleet's own gateway
  // and process supervisor work without it, so a deployment running a different
  // (or no) web plugin must not fail to activate the fleet over a missing route.
  ctx.inject(['webServer'], (web) => {
    for (const route of routes) ctx.effect(() => web.webServer.register(route))
  })

  // Load the registry once, then optionally bring boxes up. Starting a box is a
  // child process, so it must never block plugin activation.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      boxes = await readRegistry(registryPath)
      loaded = true
      if (config.autostart) {
        for (const box of boxes.filter((entry) => entry.enabled)) {
          if (cancelled) return
          await launch(box).catch((error) =>
            ctx.logger?.warn?.('fleet: box %s did not start: %s', box.id, error.message),
          )
        }
      }
    })()
    return async () => {
      cancelled = true
      await supervisor.stopAll()
      await (await gateway.catch(() => undefined))?.close()
    }
  })

  /** Whether the registry finished loading; diagnostics read it. */
  Object.defineProperty(ctx, 'fleet', {
    value: {
      state: () => ({ loaded, boxes, running: supervisor.ids(), gatewayPort: config.gatewayPort }),
      sshProviderPackages: SSH_PROVIDER_PACKAGES,
    },
    configurable: true,
  })
}

/** Read a bounded JSON request body. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((done, fail) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > limit) fail(new Error('fleet: request body too large'))
    })
    req.on('end', () => {
      try {
        done(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        fail(new Error(`fleet: invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', fail)
  })
}

// `probePort` is re-exported for the supervisor tests and for a caller that
// wants to check a box port without starting it.
export { probePort }
