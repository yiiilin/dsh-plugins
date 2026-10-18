/**
 * What this dsh is made of: its profile, its mounted plugins, and its skills.
 *
 * An edge answers this so a main node can show what a machine actually has before
 * changing it. Everything here is read from the local filesystem — the edge is the only
 * party that knows its own layout, which is why this lives on the edge and not on the
 * main node.
 *
 * @module @yiln-dsh/dsh-daemon/inventory
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Collect this node's inventory.
 *
 * @param options.homeDir - `$DSH_HOME`.
 * @param options.profile - profile name being served.
 * @param options.skillsRoot - directory holding skill folders.
 * @param options.plugins - mounted plugin names, when the caller can supply them.
 * @returns the inventory.
 */
export async function readInventory({ homeDir, profile, skillsRoot, plugins }) {
  const profileDir = join(homeDir, 'profiles', profile)
  return {
    profile,
    // The bundles a profile mounts, in order: this is what decides which plugins exist.
    bundles: await readBundles(profileDir),
    // Direct dependencies, so a caller can see what was installed by hand.
    packages: await readPackages(profileDir),
    plugins: plugins ?? [],
    skills: await readSkills(skillsRoot),
  }
}

/** The `dsh.profile.bundles` list, which is the profile's composition. */
async function readBundles(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.map(String) : []
  } catch {
    // A missing or malformed manifest is a fact worth reporting as "none", not an error
    // that stops the whole inventory.
    return []
  }
}

/** Direct dependencies of the profile. */
async function readPackages(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    const dependencies = manifest?.dependencies
    return dependencies !== null && typeof dependencies === 'object' ? Object.keys(dependencies) : []
  } catch {
    return []
  }
}

/**
 * Skills, each a directory with a `SKILL.md`.
 *
 * Only the name and the frontmatter `description` are read: a skill's body can be large,
 * and a list does not need it.
 */
async function readSkills(skillsRoot) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(skillsRoot, entry.name)
    let description = ''
    try {
      const body = await readFile(join(dir, 'SKILL.md'), 'utf8')
      description = frontmatterDescription(body)
    } catch {
      // A directory without SKILL.md is not a skill; skip it rather than listing a name
      // that cannot be used.
      continue
    }
    skills.push({ name: entry.name, description })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Pull `description:` out of a SKILL.md frontmatter block. */
export function frontmatterDescription(text) {
  if (!text.startsWith('---')) return ''
  const end = text.indexOf('\n---', 3)
  if (end === -1) return ''
  const block = text.slice(3, end)
  const match = /^description:\s*(.*)$/mu.exec(block)
  if (match === null) return ''
  return match[1].trim().replace(/^['"]|['"]$/gu, '')
}

/** Whether a path is a directory, for callers that need to check before reading. */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Default skills location: `~/.agents/skills`, which is where dsh installs them. */
export function defaultSkillsRoot(home) {
  return join(home, '.agents', 'skills')
}

/** Profile name inferred from a directory, used when none is configured. */
export function profileNameOf(path) {
  return basename(path)
}
