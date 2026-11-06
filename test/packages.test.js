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
  // Seven remain after auth-webserver, fleet, delegate-mode, tool-restrict-presets
  // and tool-visibility were retired. The bound guards against the directory being
  // read as empty; it is not a census, so retiring another package is not a failure.
  assert.ok(packages.length >= 7, `expected the split plugins, found ${packages.join(', ')}`)
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

test('every package declares the same dsh version window', async () => {
  // DSH reads an own `engines.dsh` alone and ignores peerDependencies, evaluating
  // it with includePrerelease. Both `-0` markers are load-bearing: npm has never
  // published a stable 0.2.1 (only alpha/rc), so `>=0.2.1` would deny the runtime
  // this suite is verified against, and `0.3.0-alpha.1` sorts below `0.3.0`, so a
  // plain `<0.3.0` would admit the untested 0.3.0 prerelease line.
  const expected = '>=0.2.1-0 <0.3.0-0'
  for (const name of packages) {
    const pkg = JSON.parse(await read(`pkgs/${name}/package.json`))
    assert.equal(pkg.engines?.dsh, expected, `${name}: engines.dsh must be ${expected}`)
    assert.equal(pkg.peerDependencies, undefined, `${name}: engines.dsh decides alone; a peer window would be ignored`)
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
  // `gateway` and `supervisor` are host-only; every other package carries a client half.
  assert.ok(clientPackages >= 5, `expected at least 5 client halves, found ${clientPackages}`)
})

test('the workspace glob matches every package directory', async () => {
  const workspace = await read('pnpm-workspace.yaml')
  assert.match(workspace, /pkgs\/\*/u)
})
