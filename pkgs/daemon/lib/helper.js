/**
 * Helper artifact acquisition: cache, then build, then download.
 *
 * An SSH profile needs one executable on the remote host. That artifact is a
 * *statically linked* single file — no Node, no glibc/libstdc++ requirement, no
 * node_modules — because the target machine cannot be assumed to provide any of
 * them (a CentOS 7 host has neither a modern glibc nor a Node).
 *
 * Why static and not the smaller alternatives, measured on this deployment:
 *
 * - Node SEA copies the *local* `node`, which is dynamically linked against
 *   `libc.so.6`, `libstdc++.so.6` and `libgcc_s.so.1`, so the artifact inherits
 *   the build host's glibc floor (119 MB, 41 MB gzipped).
 * - `bun build --compile --target=bun-linux-x64-musl` still imports
 *   `libstdc++.so.6` and `libgcc_s.so.1`, and fails to start on a slim host.
 * - `@yao-pkg/pkg` with `node22-linuxstatic-*` produces `statically linked`
 *   (69 MB, 26 MB gzipped) that runs on any x86-64 Linux.
 *
 * @module @yiln-dsh/dsh-daemon/helper
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'

/** Where the bundled helper entry lives inside the published `dsh-ssh` package. */
const HELPER_ENTRY = 'node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'

/** `pkg` target for a static build, per architecture. */
const PKG_TARGETS = {
  x64: 'node22-linuxstatic-x64',
  arm64: 'node22-linuxstatic-arm64',
}

/**
 * Path of one cached artifact.
 *
 * The key includes the version, so a dsh upgrade invalidates the cache instead of
 * distributing a helper that disagrees with the running `dsh-ssh`.
 *
 * @param cacheDir - manifest cache directory.
 * @param version - helper version.
 * @param arch - `x64` or `arm64`.
 * @returns the `.gz` path.
 */
export function cachePath(cacheDir, version, arch) {
  return join(cacheDir, `dsh-helper-${version}-linux-${arch}.gz`)
}

/**
 * Resolve a helper artifact, preferring the cheapest source that works.
 *
 * @param options - acquisition settings.
 * @param options.cacheDir - directory holding cached artifacts.
 * @param options.version - helper version (the `dsh-ssh` version).
 * @param options.arch - target architecture.
 * @param options.downloadUrl - template with `<version>` and `<arch>` placeholders.
 * @param options.build - whether a local build is allowed.
 * @param options.logger - diagnostic sink.
 * @returns the artifact path and its SHA-256.
 */
export async function resolveHelper({ cacheDir, version, arch, downloadUrl, build = true, logger }) {
  if (!(arch in PKG_TARGETS)) {
    throw new Error(`daemon: no helper build for architecture ${JSON.stringify(arch)} (supported: ${Object.keys(PKG_TARGETS).join(', ')})`)
  }
  const target = cachePath(cacheDir, version, arch)

  const cached = await readSidecar(target)
  if (cached !== undefined) return { path: target, sha256: cached, source: 'cache' }

  if (build) {
    try {
      const built = await buildHelper({ cacheDir, version, arch, logger })
      return { ...built, source: 'build' }
    } catch (error) {
      logger?.warn?.(`daemon: local helper build failed, falling back to download: ${error.message}`)
    }
  }

  if (downloadUrl === undefined || downloadUrl === '') {
    throw new Error('daemon: helper is neither cached nor buildable, and no downloadUrl is configured')
  }
  const url = downloadUrl.replaceAll('<version>', version).replaceAll('<arch>', arch)
  const downloaded = await downloadHelper({ url, target, logger })
  return { ...downloaded, source: 'download' }
}

/**
 * Build one static helper artifact.
 *
 * Three edits are required, each verified against a running binary:
 *
 * 1. `../package.json` version lookup → a constant: a bundle has no such file.
 * 2. `import.meta.resolve(...)` → `process.execPath`: a CommonJS bundle has no
 *    `import.meta`. All four uses are lazy and serve the PTC worker or the
 *    Windows ACL runner, neither of which an executable helper needs.
 * 3. `node:sea` → a shim whose `isSea()` is `true`: the helper reads it to decide
 *    between `kind: "node-script"` and `kind: "executable"`, and a packaged
 *    helper must report the latter.
 *
 * @param options - build settings.
 * @param options.cacheDir - destination for the artifact.
 * @param options.version - version embedded in the artifact name.
 * @param options.arch - target architecture.
 * @param options.logger - diagnostic sink.
 * @returns the artifact path and SHA-256.
 */
export async function buildHelper({ cacheDir, version, arch, logger }) {
  const entry = resolveHelperEntry()
  if (entry === undefined) {
    throw new Error('daemon: @deepseek-ai/dsh-ssh is not installed, so the helper cannot be bundled')
  }
  const work = await mkdtemp(join(tmpdir(), 'dsh-helper-build-'))
  try {
    const bundle = join(work, 'helper.cjs')
    await run('bun', ['build', entry, '--target=node', '--format=cjs', `--outfile=${bundle}`], logger)
    await writeFile(bundle, patchBundle(await readFile(bundle, 'utf8'), version))

    await writeFile(join(work, 'package.json'), `${JSON.stringify({
      name: 'dsh-ssh-helper',
      version,
      bin: 'helper.cjs',
    })}\n`)

    const binary = join(work, 'helper')
    await run('pkg', ['.', `--targets=${PKG_TARGETS[arch]}`, `--output=${binary}`], logger, work)
    // dsh-ssh verifies the executable it runs, so the published digest is the
    // binary's, not the compressed archive's.
    const binaryDigest = await digestOfFile(binary)
    if (binaryDigest === undefined) throw new Error('daemon: pkg produced no binary')

    await mkdir(cacheDir, { recursive: true })
    const staged = `${cachePath(cacheDir, version, arch)}.partial`
    await pipeline(createReadStream(binary), createGzip({ level: 9 }), createWriteStream(staged))
    await rename(staged, cachePath(cacheDir, version, arch))
    await writeSidecar(cachePath(cacheDir, version, arch), binaryDigest)
    logger?.info?.(`daemon: built helper ${version} for ${arch} (${binaryDigest.slice(0, 12)}…)`)
    return { path: cachePath(cacheDir, version, arch), sha256: binaryDigest }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Apply the three known edits to a bundled helper.
 *
 * Exported for the build's unit test: a missed edit only fails on a remote host,
 * which is the most expensive place to discover it.
 *
 * @param source - the bundled CommonJS text.
 * @param version - version to inline.
 * @returns the patched text.
 * @throws {Error} when an expected pattern is absent, which means the upstream
 *   bundle changed shape and the build must be re-examined rather than shipped.
 */
export function patchBundle(source, version) {
  let text = source

  const versionPattern = /var \{ version: (version\d*) \} = .*?\.\.\/package\.json"\);/u
  if (!versionPattern.test(text)) {
    throw new Error('daemon: helper bundle no longer reads ../package.json; re-check the patch list')
  }
  text = text.replace(versionPattern, `var $1 = ${JSON.stringify(version)};`)

  // A CommonJS bundle has no `import.meta`; every use is a lazy path that an
  // executable helper never takes.
  text = text.replace(/import\.meta\.resolve\("[^"]+"\)/gu, 'process.execPath')
  text = text.replace(/import_node_url\d*\.fileURLToPath\(process\.execPath\)/gu, 'process.execPath')
  if (text.includes('import.meta')) {
    throw new Error('daemon: helper bundle still uses import.meta after patching')
  }

  const seaPattern = /var (\w+) = require\("node:sea"\);/u
  if (!seaPattern.test(text)) {
    throw new Error('daemon: helper bundle no longer requires node:sea; re-check the patch list')
  }
  text = text.replace(seaPattern, 'var $1 = { isSea: () => true };')

  return text
}

/**
 * Download one artifact and verify it is a gzip stream before caching.
 *
 * @param options - download settings.
 * @param options.url - resolved URL.
 * @param options.target - cache destination.
 * @param options.logger - diagnostic sink.
 * @returns the artifact path and SHA-256.
 */
async function downloadHelper({ url, target, logger }) {
  logger?.info?.(`daemon: downloading helper from ${url}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`daemon: helper download answered HTTP ${response.status} from ${url}`)
  await mkdir(dirname(target), { recursive: true })
  const staged = `${target}.partial`
  const bytes = Buffer.from(await response.arrayBuffer())
  // A truncated or HTML error body would otherwise be cached as an artifact and
  // fail on a remote host with an opaque exec format error.
  if (bytes.length < 1024 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`daemon: downloaded helper is not a gzip stream (${bytes.length} bytes) from ${url}`)
  }
  await writeFile(staged, bytes)
  await rename(staged, target)
  const sha256 = await digestOfDecompressed(target)
  if (sha256 === undefined) throw new Error('daemon: downloaded helper is not readable')
  await writeSidecar(target, sha256)
  return { path: target, sha256 }
}

/**
 * Resolve the `dsh-ssh` helper entry through Node's own resolution.
 *
 * Node resolution follows the package manager's layout, so this works whether
 * the dependency is hoisted to the workspace root or nested under the package.
 * A hand-built path would break under one of those layouts.
 *
 * @returns the absolute path, or undefined when the dependency is absent.
 */
export function resolveHelperEntry() {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('@deepseek-ai/dsh-ssh/package.json')
    return join(dirname(manifest), HELPER_ENTRY.replace('node_modules/@deepseek-ai/dsh-ssh/', ''))
  } catch {
    return undefined
  }
}

/**
 * Read the executable digest recorded beside a cached archive.
 *
 * @param artifactPath - the cached `.gz` path.
 * @returns the digest, or undefined when absent or malformed.
 */
async function readSidecar(artifactPath) {
  try {
    const text = await readFile(`${artifactPath}.sha256`, 'utf8')
    const value = text.trim()
    return /^[0-9a-f]{64}$/u.test(value) ? value : undefined
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Record the executable digest beside a cached archive.
 *
 * @param artifactPath - the cached `.gz` path.
 * @param sha256 - digest of the decompressed executable.
 */
async function writeSidecar(artifactPath, sha256) {
  await writeFile(`${artifactPath}.sha256`, `${sha256}\n`)
}

/** SHA-256 of a file, or undefined when it does not exist. */
async function digestOfFile(path) {
  try {
    await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** SHA-256 of a gzip file's decompressed contents. */
async function digestOfDecompressed(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), createGunzip(), hash)
  return hash.digest('hex')
}

/** SHA-256 of a buffer. */
export function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Run one build tool, surfacing its output on failure.
 *
 * `pkg` is invoked through `npx -y` because it is a build-time tool rather than
 * a runtime dependency; resolution through the package manager keeps it out of
 * the published artifact.
 */
function run(command, args, logger, cwd) {
  const resolved = command === 'pkg' ? 'npx' : command
  const finalArgs = command === 'pkg' ? ['-y', '@yao-pkg/pkg', ...args] : args
  return new Promise((done, fail) => {
    execFile(
      resolved,
      finalArgs,
      { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          logger?.debug?.(stdout.trim())
          done()
          return
        }
        fail(new Error(`daemon: ${command} failed: ${(stderr || stdout || error.message).trim().slice(-2000)}`))
      },
    )
  })
}

/**
 * Write the artifact for a remote host, decompressing on the far side.
 *
 * The artifact is gzipped at rest, so the transfer is the compressed bytes and
 * the remote `gunzip` produces the executable. A digest is compared afterwards,
 * because a truncated pipe would otherwise leave a half-written binary in place.
 *
 * @param options - distribution settings.
 * @param options.artifactPath - cached `.gz` path.
 * @param options.sha256 - expected digest of the *decompressed* binary.
 * @param options.remotePath - destination on the remote host.
 * @param options.exec - runs one `ssh` invocation, resolving with its output.
 * @param options.copy - streams a local file to a remote path.
 * @param options.logger - diagnostic sink.
 * @returns the installed digest.
 */
export async function installHelper({ artifactPath, sha256, remotePath, exec, copy, logger }) {
  const existing = await exec(`sha256sum ${quote(remotePath)} 2>/dev/null | cut -d' ' -f1`).catch(() => '')
  if (existing.trim() === sha256) {
    logger?.info?.(`daemon: helper already installed at ${remotePath}`)
    return sha256
  }
  await exec(`mkdir -p ${quote(dirname(remotePath))}`)
  const temporary = `${remotePath}.gz`
  await copy(artifactPath, temporary)
  await exec(
    `gunzip -c ${quote(temporary)} > ${quote(`${remotePath}.partial`)} && ` +
      `chmod +x ${quote(`${remotePath}.partial`)} && ` +
      `mv ${quote(`${remotePath}.partial`)} ${quote(remotePath)} && ` +
      `rm -f ${quote(temporary)} && ` +
      `sha256sum ${quote(remotePath)} | cut -d' ' -f1`,
  ).then((installed) => {
    if (installed.trim() !== sha256) {
      throw new Error(`daemon: installed helper digest ${installed.trim().slice(0, 12)}… does not match ${sha256.slice(0, 12)}…`)
    }
  })
  logger?.info?.(`daemon: helper installed at ${remotePath}`)
  return sha256
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}
