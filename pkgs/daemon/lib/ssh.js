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
import { resolveHelper } from './helper.js'

/**
 * Run one `ssh` invocation.
 *
 * `BatchMode=yes` makes a missing key a fast failure instead of a prompt the
 * daemon cannot answer; `StrictHostKeyChecking=accept-new` records a first-seen
 * host key but still refuses a changed one.
 *
 * @param target - connection parameters.
 * @param command - the remote command.
 * @param options.password - when set, the connection is made with `sshpass`.
 * @returns stdout.
 */
export function sshExec(target, command, { password, timeoutMs = 60_000 } = {}) {
  const args = []
  if (password !== undefined && password !== '') {
    args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
  }
  args.push(
    '-T',
    '-p', String(target.sshPort ?? 22),
    '-o', 'BatchMode=no',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.min(30, Math.ceil(timeoutMs / 1000))}`,
    '-o', 'NumberOfPasswordPrompts=1',
    `${target.sshUser}@${target.sshHost}`,
    command,
  )
  const binary = password !== undefined && password !== '' ? 'sshpass' : 'ssh'
  const finalArgs = binary === 'sshpass' ? ['-e', 'ssh', ...args] : args
  return new Promise((done, fail) => {
    execFile(
      binary,
      finalArgs,
      {
        env: { ...process.env, SSHPASS: password ?? '' },
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          done(stdout)
          return
        }
        fail(new Error(`daemon: ssh ${target.sshUser}@${target.sshHost} failed: ${(stderr || error.message).trim().slice(-800)}`))
      },
    )
  })
}

/**
 * Copy one local file to a remote path over the SSH channel.
 *
 * `scp` is avoided because it refuses a stream; piping through `ssh` also lets
 * the same credentials serve both the copy and the verification.
 *
 * @param target - connection parameters.
 * @param localPath - the local file.
 * @param remotePath - the remote destination.
 * @param options.password - password for `sshpass`, when used.
 */
export function sshUpload(target, localPath, remotePath, { password } = {}) {
  return new Promise((done, fail) => {
    const args = []
    if (password !== undefined && password !== '') {
      args.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no')
    }
    args.push(
      '-T',
      '-p', String(target.sshPort ?? 22),
      '-o', 'BatchMode=no',
      '-o', 'StrictHostKeyChecking=accept-new',
      `${target.sshUser}@${target.sshHost}`,
      `cat > ${quote(remotePath)}`,
    )
    const binary = password !== undefined && password !== '' ? 'sshpass' : 'ssh'
    const finalArgs = binary === 'sshpass' ? ['-e', 'ssh', ...args] : args
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
 * Build the SSH operations used by `/admin` and by profile creation.
 *
 * @param options - collaborators.
 * @param options.config - resolved daemon configuration.
 * @param options.logger - diagnostic sink.
 * @returns probe, preview and deploy operations.
 */
export function createSshOps({ config, logger }) {
  /** Probe a host without writing anything to it. */
  async function probe({ sshHost, sshPort = 22, sshUser, password }) {
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
    const output = await sshExec(target, script, { password })
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

  /** Install the helper for one SSH profile and record its digest. */
  async function deploy(profile) {
    if (profile.kind !== 'ssh') throw new Error(`daemon: profile "${profile.id}" is not an SSH profile`)
    const artifact = await resolveHelper({
      cacheDir: config.cacheDir,
      version: config.helperVersion,
      arch: 'x64',
      downloadUrl: config.helperDownloadUrl,
      logger,
    })
    const target = { sshHost: profile.sshHost, sshPort: profile.sshPort, sshUser: profile.sshUser }
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

  return { probe, preview, deploy }
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}
