/**
 * SSH side of the admin surface: probe a host, install the helper.
 *
 * Deployment is deliberately two-step. {@link createSshOps.probe} reads the host
 * and reports what it found; {@link createSshOps.deploy} writes the helper. A
 * caller must ask between them, so no file reaches a remote machine until the
 * operator has seen what it is.
 *
 * @module @yiln-dsh/dsh-daemon/ssh
 */

import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { installPublicKeyCommand, removePublicKeyCommand } from './credentials.js'
import { resolveHelper } from './helper.js'

/**
 * Options shared by every `ssh` invocation.
 *
 * `StrictHostKeyChecking=accept-new` records a first-seen key but still refuses a
 * changed one: a daemon may pin an unknown host on the operator's behalf, but it
 * must not silently follow a swapped key. `LogLevel=ERROR` keeps the benign
 * "permanently added" notice off stderr, where it would otherwise be reported as
 * the cause of a failure.
 */
const BASE_OPTIONS = ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR', '-o', 'NumberOfPasswordPrompts=1']

/**
 * Build the argument list for one invocation.
 *
 * `BatchMode` follows the authentication mode: a key or agent connection must
 * fail fast rather than wait for a prompt, while password authentication needs
 * prompts enabled for `sshpass` to answer.
 */
export function sshArguments(target, command, passwordMode, identityFile) {
  // An alias target carries its own user; a bootstrap target needs one spelled out.
  const destination = target.alias !== undefined
    ? target.alias
    : `${target.sshUser}@${target.sshHost}`
  return [
    ...BASE_OPTIONS,
    '-o', `BatchMode=${passwordMode ? 'no' : 'yes'}`,
    ...(target.sshPort === undefined ? [] : ['-p', String(target.sshPort)]),
    ...(identityFile === undefined ? [] : ['-i', identityFile]),
    ...(passwordMode ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no'] : []),
    destination,
    command,
  ]
}

/**
 * Run one `ssh` invocation.
 *
 * @param target - connection parameters.
 * @param command - the remote command.
 * @param options.password - when set, the connection is made with `sshpass`.
 * @param options.timeoutMs - ceiling for the whole invocation.
 * @returns stdout.
 */
export function sshExec(target, command, { password, identityFile, timeoutMs = 60_000 } = {}) {
  const passwordMode = password !== undefined && password !== ''
  const args = sshArguments(target, command, passwordMode, identityFile)
  const binary = passwordMode ? 'sshpass' : 'ssh'
  const finalArgs = passwordMode ? ['-e', 'ssh', ...args] : args
  return new Promise((done, fail) => {
    execFile(
      binary,
      finalArgs,
      { env: { ...process.env, SSHPASS: password ?? '' }, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error === null) {
          done(stdout)
          return
        }
        const where = target.alias !== undefined ? target.alias : `${target.sshUser}@${target.sshHost}`
        fail(new Error(`daemon: ssh ${where} failed: ${(stderr || error.message).trim().slice(-800)}`))
      },
    )
  })
}

/**
 * Copy one local file to a remote path over the SSH channel.
 *
 * `scp` is avoided because it cannot stream; piping through `ssh` also lets the
 * same credentials serve both the copy and the verification.
 *
 * @param target - connection parameters.
 * @param localPath - the local file.
 * @param remotePath - the remote destination.
 * @param options.password - password for `sshpass`, when used.
 */
export function sshUpload(target, localPath, remotePath, { password, identityFile } = {}) {
  const passwordMode = password !== undefined && password !== ''
  const args = sshArguments(target, `cat > ${quote(remotePath)}`, passwordMode, identityFile)
  const binary = passwordMode ? 'sshpass' : 'ssh'
  const finalArgs = passwordMode ? ['-e', 'ssh', ...args] : args
  return new Promise((done, fail) => {
    const child = execFile(
      binary,
      finalArgs,
      { env: { ...process.env, SSHPASS: password ?? '' }, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          done()
          return
        }
        fail(new Error(`daemon: helper upload failed: ${(stderr || error.message).trim().slice(-800)}`))
      },
    )
    createReadStream(localPath).pipe(child.stdin)
  })
}

/**
 * Check whether one managed environment can actually work.
 *
 * Two questions in order, because they fail for unrelated reasons and need
 * unrelated fixes:
 *
 * 1. Is ssh reachable with the environment's own key?
 * 2. Does the remote helper exist and match the recorded digest?
 *
 * A process can be running while both are false — the dsh child survives a dropped
 * SSH connection — so this answers "can it work", not "is it alive".
 *
 * @param entry - the environment record.
 * @param options.alias - the ssh_config alias dsh-ssh uses.
 * @param options.timeoutMs - ceiling for each step.
 * @returns the state and the detail that produced it.
 */
export async function checkHealth(entry, { alias, timeoutMs = 8000 }) {
  const target = { alias }
  let reachable
  try {
    reachable = (await sshExec(target, 'printf reachable', { timeoutMs })).trim() === 'reachable'
  } catch (error) {
    return { state: 'unreachable', detail: firstLine(error.message) }
  }
  if (!reachable) return { state: 'unreachable', detail: 'no answer from the remote host' }

  let remoteDigest
  try {
    remoteDigest = (await sshExec(
      target,
      `sha256sum ${quote(entry.sshHelper)} 2>/dev/null | cut -d' ' -f1`,
      { timeoutMs },
    )).trim()
  } catch (error) {
    return { state: 'helper-bad', detail: firstLine(error.message) }
  }
  if (remoteDigest === '') {
    return { state: 'helper-bad', detail: `helper missing at ${entry.sshHelper}` }
  }
  if (remoteDigest !== entry.sshHelperHash) {
    return {
      state: 'helper-bad',
      detail: `helper digest ${remoteDigest.slice(0, 12)}… differs from recorded ${entry.sshHelperHash.slice(0, 12)}…`,
    }
  }
  return { state: 'ok', detail: '' }
}

function firstLine(text) {
  return String(text).split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? ''
}

/**
 * Build the SSH operations used by `/admin` and by profile creation.
 *
 * @param options - collaborators.
 * @param options.config - resolved daemon configuration.
 * @param options.logger - diagnostic sink.
 * @returns probe, preview and deploy operations.
 */
export function createSshOps({ config, logger }) {
  /**
   * Probe a host before anything is written to it.
   *
   * This is the bootstrap path: it uses the operator's own credential and takes a
   * bare host, because no ssh config fragment exists yet. The steady-state
   * {@link checkHealth} is a different function with a different target.
   */
  async function probe({ sshHost, sshPort, sshUser, password, identityFile }) {
    const target = { sshHost, sshPort, sshUser }
    const script = [
      'echo "hostname=$(hostname 2>/dev/null || echo unknown)"',
      'echo "arch=$(uname -m)"',
      'echo "os=$(. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID" || echo unknown)"',
      'echo "glibc=$(ldd --version 2>/dev/null | head -1 | grep -oE "[0-9]+\\.[0-9]+$" || echo none)"',
      'echo "node=$(command -v node 2>/dev/null || echo none)"',
      'echo "home=$(printf %s "$HOME")"',
      'echo "writable=$( [ -w "$HOME" ] && echo yes || echo no)"',
    ].join('; ')
    const output = await sshExec(target, script, { password, identityFile })
    const fields = {}
    for (const line of output.split('\n')) {
      const at = line.indexOf('=')
      if (at === -1) continue
      fields[line.slice(0, at)] = line.slice(at + 1).trim()
    }
    const arch = fields.arch === 'aarch64' || fields.arch === 'arm64' ? 'arm64' : 'x64'
    return {
      hostname: fields.hostname,
      arch,
      os: fields.os,
      glibc: fields.glibc,
      node: fields.node,
      home: fields.home,
      writable: fields.writable === 'yes',
      // A statically linked helper needs neither Node nor a modern glibc, so the
      // only hard requirement is a writable destination directory.
      helperSupported: true,
    }
  }

  /** Resolve the artifact that would be installed, without touching the host. */
  async function preview({ arch = 'x64' }) {
    const artifact = await resolveHelper({
      cacheDir: config.cacheDir,
      version: config.helperVersion,
      arch,
      downloadUrl: config.helperDownloadUrl,
      logger,
    })
    return {
      arch,
      source: artifact.source,
      sha256: artifact.sha256,
      path: artifact.path,
    }
  }

  /** Install the helper for one environment and record its digest. */
  async function deploy(profile) {
    const artifact = await resolveHelper({
      cacheDir: config.cacheDir,
      version: config.helperVersion,
      arch: 'x64',
      downloadUrl: config.helperDownloadUrl,
      logger,
    })
    // Prefer the alias: the ssh config carries the generated key, so `BatchMode=yes`
    // can succeed. `dsh-ssh` uses the same alias as its host.
    const target = profile.sshKeyPath === undefined
      ? { sshHost: profile.sshHost, sshPort: profile.sshPort, sshUser: profile.sshUser }
      : { alias: aliasFor(profile) }
    const existing = await sshExec(target, `sha256sum ${quote(profile.sshHelper)} 2>/dev/null | cut -d' ' -f1`).catch(() => '')
    if (existing.trim() === artifact.sha256) {
      logger?.info?.(`daemon: helper already current on ${profile.sshHost}`)
      return { installed: true, skipped: true, sha256: artifact.sha256 }
    }
    await sshExec(target, `mkdir -p ${quote(dirname(profile.sshHelper))}`)
    const staged = `${profile.sshHelper}.gz`
    await sshUpload(target, artifact.path, staged)
    const installed = await sshExec(
      target,
      `gunzip -c ${quote(staged)} > ${quote(`${profile.sshHelper}.partial`)} && ` +
        `chmod +x ${quote(`${profile.sshHelper}.partial`)} && ` +
        `mv ${quote(`${profile.sshHelper}.partial`)} ${quote(profile.sshHelper)} && ` +
        `rm -f ${quote(staged)} && ` +
        `sha256sum ${quote(profile.sshHelper)} | cut -d' ' -f1`,
    )
    if (installed.trim() !== artifact.sha256) {
      throw new Error(
        `daemon: installed helper digest ${installed.trim().slice(0, 12)}… differs from ${artifact.sha256.slice(0, 12)}…`,
      )
    }
    return { installed: true, skipped: false, sha256: artifact.sha256 }
  }

  /**
   * Install one environment's public key under its marker.
   *
   * The bootstrap credential is used here and nowhere else; after this the alias
   * authenticates with the generated key alone.
   *
   * @param input - host, optional port, user, bootstrap password, key and id.
   * @returns how many marker lines exist remotely (1 on success).
   */
  async function installPublicKey({ sshHost, sshPort, sshUser, password, identityFile, publicKey, id }) {
    const target = { sshHost, sshPort, sshUser }
    const output = await sshExec(target, installPublicKeyCommand(publicKey, id), { password, identityFile })
    const count = Number(output.trim().split('\n').pop())
    if (count !== 1) throw new Error(`daemon: expected one authorized_keys line for "${id}", found ${count}`)
    return { installed: true, count }
  }

  /**
   * Remove this environment's public key line from the remote host.
   *
   * Matched by the `dsh-daemon:<id>` marker, so a line installed by anything else is
   * never touched. Uses the bootstrap credential: the old key is about to stop working.
   *
   * @param entry - the environment whose line should go.
   * @param options.password - bootstrap password, when used.
   * @param options.identityFile - bootstrap identity file, when used.
   * @returns whether a line was reported removed.
   */
  async function removePublicKey(entry, { password, identityFile } = {}) {
    const target = { sshHost: entry.sshHost, sshPort: entry.sshPort, sshUser: entry.sshUser }
    const output = await sshExec(target, removePublicKeyCommand(entry.id), { password, identityFile })
    return { removed: output.includes('removed') }
  }

  /**
   * Remove this environment's helper from the remote host.
   *
   * Uses the environment's own alias, so it works after the bootstrap credential is
   * gone.
   */
  async function removeRemoteHelper(entry) {
    const target = { alias: aliasFor(entry) }
    await sshExec(target, `rm -f ${quote(entry.sshHelper)}`)
    return { removed: true }
  }

  return {
    probe,
    preview,
    deploy,
    installPublicKey,
    removePublicKey,
    removeRemoteHelper,
    health: (entry) => checkHealth(entry, { alias: aliasFor(entry) }),
  }
}

/** The ssh_config alias for one environment; `dsh-ssh` uses the same string. */
export function aliasFor(entry) {
  return `dsh-${entry.id}`
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}
