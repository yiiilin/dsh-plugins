/**
 * Materialize one profile directory: the manifest, the patch layer and the
 * dependencies that make the profile behave like the rest of the deployment.
 *
 * A generated profile is ordinary — `dsh --profile <name>` behaves exactly like a
 * hand-written one. What this module adds is the part an operator would otherwise
 * assemble by hand: the bundle list, the harness pins a preset needs, and for a
 * remote target the provider swap from local to SSH-backed.
 *
 * @module @yiln-dsh/dsh-daemon/provision
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'

/**
 * Header shared by every generated patch file.
 *
 * The rows below the header are seeded by the daemon once, at creation. The
 * Loader's Include plugin then owns the file: it rewrites this same path whenever
 * a runtime setting changes, and its YAML dialect round-trips `!!js` expressions,
 * so an operator fragment survives that rewrite. The daemon must therefore never
 * re-seed a profile that already exists, or a user's settings would be lost.
 */
const PATCH_HEADER = `# Seeded by @yiln-dsh/dsh-daemon; afterwards the harness persists settings here.
# Profile lifecycle is managed through the daemon's /admin surface.
`

/**
 * Harness modules a preset may mount that exist only in the dsh install tree.
 *
 * Declaring them as dependencies pins the profile to resolvable packages, so a
 * preset survives a trimmed or self-contained dsh install.
 */
export const HARNESS_MODULES = [
  'dsh-tool-schedule',
  'dsh-plugin-manager',
  'dsh-workflow-ptc',
  'dsh-tool-terminal',
  'dsh-experimental-worktree',
  'dsh-experimental-tool-worktree',
]

/**
 * Packages a remote profile must install to replace its local providers.
 *
 * These are mounted by `renderSshPatch` rows, so they must also be declared:
 * a row naming an unresolvable package fails to import, and every service that
 * depends on it stays pending — the profile listens but cannot create a session.
 */
export const SSH_PROVIDER_MODULES = ['dsh-ssh', 'dsh-fs-ssh', 'dsh-subprocess-ssh', 'dsh-sandbox-ssh']

/**
 * Dependencies a generated profile declares for its bundle layers.
 *
 * @param bundles - the profile's bundle layers.
 * @param options.agentPresetsDir - `$DSH_HOME/.agent-presets`, when one exists.
 * @param options.harnessVersion - version to pin the harness modules to.
 * @returns the dependency map written into the profile manifest.
 */
export function profileDependencies(bundles, { agentPresetsDir, harnessVersion, kind }) {
  const dependencies = {}
  if (agentPresetsDir !== undefined && bundles.includes('@local/yiln-agent-preset')) {
    // A link keeps the profile on the deployment's live preset, not a copy.
    dependencies['@local/yiln-agent-preset'] = `link:${join(agentPresetsDir, 'yiln', 'bundle')}`
  }
  if (harnessVersion !== undefined) {
    for (const module of HARNESS_MODULES) dependencies[`@deepseek-ai/${module}`] = harnessVersion
    if (kind === 'ssh') {
      for (const module of SSH_PROVIDER_MODULES) dependencies[`@deepseek-ai/${module}`] = harnessVersion
    }
  }
  return dependencies
}

/**
 * Concatenate generated rows with an operator fragment into one YAML sequence.
 *
 * The fragment is appended as text, never parsed: a deployment's rows may carry
 * the Loader's `!!js` tag, which a YAML round-trip would destroy. `dump` output
 * and a hand-written fragment both start every row with `- ` at column zero, so
 * joining them leaves exactly one sequence.
 *
 * @param rows - the generated rows.
 * @param fragment - YAML text holding additional rows, or empty.
 * @returns the patch file body.
 */
export function compose(rows, fragment = '') {
  const body = dumpYaml(rows, { lineWidth: 200 }).trimEnd()
  const extra = fragment.trim()
  return `${PATCH_HEADER}${body}${extra === '' ? '' : `\n\n${extra}`}\n`
}

/**
 * Render the patch layer for a local profile.
 *
 * @param options.workspace - the working directory sessions start in.
 * @param options.fragment - operator rows appended verbatim (model routing,
 *   preset defaults); deployment facts this package must not know.
 * @returns the patch text, one top-level YAML sequence.
 */
export function renderLocalPatch({ workspace, fragment = '' }) {
  return compose([{ id: 'working-directory', config: { defaultDirectory: workspace } }], fragment)
}

/**
 * Render the patch layer for a remote profile.
 *
 * The process still runs on this host; only the filesystem, subprocess and
 * sandbox providers move to the SSH host. `sandbox-policy` keeps
 * `danger-full-access` paired with `approval: never` — permission presets compose
 * both, and a half-configured pair matches no preset, which refuses activation.
 *
 * @param profile - the SSH profile.
 * @param options.fragment - operator rows appended verbatim.
 * @returns the patch text, one top-level YAML sequence.
 */
export function renderSshPatch(profile, { fragment = '' } = {}) {
  return compose(
    [
      {
        insert: [
          {
            id: 'ssh',
            name: '@deepseek-ai/dsh-ssh',
            config: {
              host: profile.sshHost,
              ...(profile.sshNode === undefined
                ? { launch: { kind: 'executable' } }
                : { launch: { kind: 'node-script', node: profile.sshNode } }),
              helper: profile.sshHelper,
              helperHash: profile.sshHelperHash,
              workspace: profile.workspace,
            },
          },
        ],
      },
      { id: 'fs-sandbox', disabled: true },
      { insert: [{ id: 'fs-ssh', name: '@deepseek-ai/dsh-fs-ssh' }] },
      { id: 'subprocess', disabled: true },
      { insert: [{ id: 'subprocess-ssh', name: '@deepseek-ai/dsh-subprocess-ssh' }] },
      { id: 'sandbox', disabled: true },
      { insert: [{ id: 'sandbox-ssh', name: '@deepseek-ai/dsh-sandbox-ssh' }] },
      { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: profile.workspace } },
      { id: 'approval', config: { policy: 'never' } },
      { id: 'working-directory', config: { defaultDirectory: profile.workspace } },
    ],
    fragment,
  )
}

/**
 * Seed one profile directory.
 *
 * The manifest and root file are rewritten on every call, because they are pure
 * daemon output. The patch file is different: the harness persists runtime
 * settings into it, so an existing patch is left untouched unless `reseed` is set.
 *
 * @param profileDir - absolute profile directory.
 * @param profile - the profile record.
 * @param options.bundles - bundle layers.
 * @param options.dependencies - manifest dependencies.
 * @param options.fragment - operator patch rows.
 * @returns the written paths.
 */
export async function writeProfile(
  profileDir,
  profile,
  { bundles, dependencies = {}, fragment = '', reseed = false },
) {
  await mkdir(profileDir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${profile.profile}`,
    private: true,
    dependencies,
    dsh: { profile: { bundles: [...bundles], patchReload: 'startup' } },
  }
  const packagePath = join(profileDir, 'package.json')
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
  // pnpm treats a directory without this as part of a parent workspace, which
  // would install a profile's packages into the deployment instead of itself.
  await writeFile(
    join(profileDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (reseed || (await isMissing(patchPath))) {
    await writeFile(
      patchPath,
      profile.kind === 'ssh'
        ? renderSshPatch(profile, { fragment })
        : renderLocalPatch({ workspace: profile.workspace, fragment }),
    )
  }
  return { packagePath, patchPath, rootPath: join(profileDir, 'cordis.yml') }
}

/**
 * Read a generated profile's patch text, for display in the admin surface.
 *
 * @param profileDir - the profile directory.
 * @returns the patch text, or undefined when absent.
 */
export async function readProfilePatch(profileDir) {
  try {
    return await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Whether a path is absent. */
async function isMissing(path) {
  try {
    await readFile(path)
    return false
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}
