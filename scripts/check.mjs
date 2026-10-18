// Validate every package under pkgs/ as an independently installable plugin.
//
// This replaces the old single-package check: there is no aggregate bundle any
// more, so each package owns its own dsh.bundle patch, optional dsh.client
// declaration, and Loader row. A package that would fail to mount is a broken
// GitHub install, so every rule below is a mounting requirement.
import assert from 'node:assert/strict'
import { readdir, readFile, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = new URL('../', import.meta.url)
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value }),
])

/** Package directory names, in review order. */
const names = (await readdir(new URL('pkgs/', root), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

assert.ok(names.length > 0, 'pkgs/ must contain at least one package')

const seenNames = new Set()
for (const name of names) {
  const dir = new URL(`pkgs/${name}/`, root)
  const manifest = JSON.parse(await readFile(new URL('package.json', dir), 'utf8'))

  // --- identity ---------------------------------------------------------------
  assert.equal(manifest.name, `@yiln-dsh/dsh-${name}`, `${name}: package name must follow @yiln-dsh/dsh-<dir>`)
  assert.ok(!seenNames.has(manifest.name), `${name}: duplicate package name`)
  seenNames.add(manifest.name)
  assert.equal(manifest.type, 'module', `${name}: type must be module`)

  // --- bundle layer -----------------------------------------------------------
  // Without a dsh.bundle patch the package installs as a plain dependency and
  // contributes no Loader row, which is a silently dead install.
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml', `${name}: dsh.bundle.patch must be ./cordis.patch.yml`)
  const patchText = await readFile(new URL('cordis.patch.yml', dir), 'utf8')
  const patches = yaml.load(patchText, { schema })
  assert.ok(Array.isArray(patches), `${name}: cordis.patch.yml must be a patch list`)
  const rows = patches.flatMap((entry) => entry?.insert ?? [])
  assert.equal(rows.length, 1, `${name}: exactly one Loader row is expected, got ${rows.length}`)
  const row = rows[0]
  assert.equal(row.name, manifest.name, `${name}: the row must name this package, got ${JSON.stringify(row.name)}`)
  assert.ok(typeof row.id === 'string' && row.id.length > 0, `${name}: the row needs an id`)

  // --- host half --------------------------------------------------------------
  await access(new URL('index.js', dir))
  const module = await import(new URL('index.js', dir))
  assert.equal(typeof module.apply, 'function', `${name}: index.js must export apply()`)
  assert.ok(Array.isArray(module.inject), `${name}: index.js must export an inject array`)
  assert.equal(manifest.exports?.['.'], './index.js', `${name}: exports["."] must be ./index.js`)
  // A row that injects fewer services than its module reads leaves ctx.get()
  // undefined at runtime, which silently drops registrations.
  if (Array.isArray(row.inject)) {
    const declared = new Set(row.inject)
    const missing = module.inject.filter((service) => !declared.has(service))
    assert.deepEqual(missing, [], `${name}: Loader row "${row.id}" must inject every service of its module`)
  }

  // Node rejects an exports object that mixes subpath keys with condition names,
  // which is exactly what a bare "package.json" key does. Such a package cannot
  // be imported at all, so this is a mounting requirement, not a style rule.
  const exportKeys = Object.keys(manifest.exports ?? {})
  const subpaths = exportKeys.filter((key) => key.startsWith('.'))
  assert.equal(
    subpaths.length,
    exportKeys.length,
    `${name}: every exports key must be a subpath starting with "." (found ${exportKeys.filter((k) => !k.startsWith('.')).join(', ')})`,
  )
  assert.equal(manifest.exports?.['./package.json'], './package.json', `${name}: exports["./package.json"] must be self-referential`)

  // --- client half ------------------------------------------------------------
  const clientPath = manifest.exports?.['./client']
  if (clientPath === undefined) {
    assert.equal(manifest.dsh?.client, undefined, `${name}: dsh.client without an exports["./client"] target`)
  } else {
    assert.equal(manifest.dsh?.client?.platform, 'web', `${name}: dsh.client.platform must be web`)
    const clientSource = await readFile(new URL(clientPath, dir), 'utf8')
    // The client source is its own loader registration, so it must name the
    // package it belongs to; a stale id silently collides with another plugin.
    const declaredId = /__ModuleLoader__\.load\(\s*\{\s*\n?\s*id:\s*['"]([^'"]+)['"]/u.exec(clientSource)?.[1]
    assert.equal(declaredId, manifest.name, `${name}: client module id must equal the package name`)
    assert.ok(/factory:\s*\(?require\)?\s*=>/u.test(clientSource), `${name}: client source must export a factory`)
  }

  // A package ships exactly what its directory holds: a source file left out of
  // `files` still exists locally, so the import only fails after installation.
  const shipped = new Set(manifest.files ?? [])
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const isSource = entry.isFile() && /\.(?:js|mjs|d\.ts)$/u.test(entry.name)
    const isDir = entry.isDirectory() && !['test', 'node_modules'].includes(entry.name)
    if (!isSource && !isDir) continue
    assert.ok(shipped.has(entry.name), `${name}: "${entry.name}" is not listed in package.json files`)
  }

  // --- syntax ----------------------------------------------------------------
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('index.js', dir))])
  if (clientPath !== undefined) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(clientPath, dir))])
  }
}

for (const file of ['scripts/migration.mjs', 'scripts/migrate-profile.mjs']) {
  try {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(file, root))])
  } catch (error) {
    if (error.code === 'ENOENT') continue
    throw error
  }
}

console.log(`Checked ${names.length} standalone packages: ${names.join(', ')}`)
