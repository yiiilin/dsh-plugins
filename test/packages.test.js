// Workspace invariants for the split package layout.
//
// Every plugin is installed on its own from GitHub (`#path:/pkgs/<name>`), so the
// checks here cover what an individual install depends on: the package is
// self-describing, it names itself consistently, and it carries no dependency on
// the old aggregate suite. Per-package mounting rules live in scripts/check.mjs.
import assert from 'node:assert/strict'
import { readdir, readFile, access } from 'node:fs/promises'
import { test } from 'node:test'

const ROOT = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, ROOT), 'utf8')

const packages = (await readdir(new URL('pkgs/', ROOT), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

test('the workspace root is not installable', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.private, true, 'the root must stay private: each plugin installs on its own')
  assert.equal(pkg.dsh, undefined, 'the root must not declare a bundle; there is no aggregate layer')
  assert.equal(pkg.exports, undefined, 'the root has no entry points')
  await assert.rejects(() => access(new URL('cordis.patch.yml', ROOT)), 'no aggregate patch may exist')
  await assert.rejects(() => access(new URL('index.js', ROOT)), 'no aggregate host anchor may exist')
})

test('every plugin is its own package with its own bundle layer', async () => {
  // Eight packages remain after auth-webserver and fleet were retired: the first is
    // served by the Host's own authorization, the second by daemon's federation.
    assert.ok(packages.length >= 8, `expected the split plugins, found ${packages.join(', ')}`)
  for (const name of packages) {
    const pkg = JSON.parse(await read(`pkgs/${name}/package.json`))
    assert.equal(pkg.name, `@yiln-dsh/dsh-${name}`, `${name}: unexpected package name`)
    // A missing bundle patch installs the package as an inert dependency.
    assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', `${name}: needs its own bundle patch`)
    await access(new URL(`pkgs/${name}/cordis.patch.yml`, ROOT))
    await access(new URL(`pkgs/${name}/index.js`, ROOT))
    await access(new URL(`pkgs/${name}/README.md`, ROOT))
  }
})

test('no package depends on the retired aggregate suite', async () => {
  for (const name of packages) {
    const pkg = JSON.parse(await read(`pkgs/${name}/package.json`))
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]
    assert.ok(
      names.every((entry) => entry !== '@yiln-dsh/dsh-plugins' && !entry.startsWith('@yiln-dsh/dsh-plugin-')),
      `${name}: still depends on the old aggregate package (${names.join(', ')})`,
    )
  }
})

test('each client half is a self-contained loader registration', async () => {
  let clientPackages = 0
  for (const name of packages) {
    const pkg = JSON.parse(await read(`pkgs/${name}/package.json`))
    const target = pkg.exports?.['./client']
    if (target === undefined) continue
    clientPackages += 1
    const source = await read(`pkgs/${name}/${target}`)
    // The suite used to assemble one bundle from many factories; each package now
    // registers itself, so the id must match the package it ships in.
    assert.ok(source.includes(`id: '${pkg.name}'`) || source.includes(`id: "${pkg.name}"`), `${name}: client id must be its package name`)
    assert.match(source, /__ModuleLoader__\.load\(/u, `${name}: client must call the module loader`)
  }
  // Six carry a browser half; daemon and tool-restrict-presets are host-only.
  assert.ok(clientPackages >= 6, `expected at least 6 client halves, found ${clientPackages}`)
})

test('the workspace glob matches every package directory', async () => {
  const workspace = await read('pnpm-workspace.yaml')
  assert.match(workspace, /pkgs\/\*/u)
})
