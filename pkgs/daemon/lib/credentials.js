/**
 * Credentials and connection facts for remote environments.
 *
 * `dsh-ssh` spawns `ssh` with a fixed argument list: there is no `-i` for an
 * identity file, no `-p` for a port, no `-F` for a config. Whatever the daemon
 * needs ssh to know must therefore live where ssh looks on its own:
 *
 * - the private key in a directory it owns,
 * - one `Host` block per environment in an included config fragment,
 * - the host key in `known_hosts`, because `dsh-ssh` pins
 *   `StrictHostKeyChecking=yes`.
 *
 * Layout, all under `$DSH_HOME/daemon`:
 *
 * ```
 * keys/<id>/id_ed25519         0600, generated, fixed name (replace = rewrite)
 * ssh_config.d/<id>.conf       0600, one Host block
 * known_hosts                  0644, appended per host after confirmation
 * ```
 *
 * The operator's own `~/.ssh/config` gains exactly one `Include` line, wrapped in
 * markers so it can be removed precisely.
 *
 * @module @yiln-dsh/dsh-daemon/credentials
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Markers around the Include line so removal is exact. */
const INCLUDE_BEGIN = '# >>> dsh-daemon environments >>>'
const INCLUDE_END = '# <<< dsh-daemon environments <<<'

/**
 * Render the `Host` block for one environment.
 *
 * A `HostName` plus `IdentityFile` is enough for `dsh-ssh`, which passes only a
 * target string to ssh. `IdentitiesOnly=yes` keeps an unrelated agent key from
 * being offered first.
 *
 * @param entry - the environment record.
 * @param options.alias - the alias `dsh-ssh` will use as its `host`.
 * @returns the fragment text.
 */
export function renderSshConfig(entry, { alias }) {
  const lines = [`Host ${alias}`]
  lines.push(`  HostName ${entry.sshHost}`)
  if (entry.sshPort !== undefined) lines.push(`  Port ${entry.sshPort}`)
  lines.push(`  User ${entry.sshUser}`)
  lines.push(`  IdentityFile ${entry.sshKeyPath}`)
  lines.push('  IdentitiesOnly yes')
  // The daemon's ssh invocations set these itself, but a fragment that only works
  // under the daemon would surprise anyone testing it by hand.
  lines.push('  StrictHostKeyChecking yes')
  return `${lines.join('\n')}\n`
}

/**
 * Ensure the operator's `~/.ssh/config` includes the daemon's fragment directory.
 *
 * Idempotent: a second call rewrites the same block rather than appending another.
 *
 * @param options.configPath - absolute path of `~/.ssh/config`.
 * @param options.includeDir - absolute directory the block includes.
 * @returns whether the file changed.
 */
export async function ensureSshInclude({ configPath, includeDir }) {
  let existing = ''
  try {
    existing = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const block = `${INCLUDE_BEGIN}\nInclude ${join(includeDir, '*')}\n${INCLUDE_END}`
  const pattern = new RegExp(`${escapeRe(INCLUDE_BEGIN)}[\\s\\S]*?${escapeRe(INCLUDE_END)}`, 'u')

  if (pattern.test(existing)) {
    const replaced = existing.replace(pattern, block)
    if (replaced === existing) return false
    await writeFile(configPath, replaced)
    return true
  }
  // A leading block keeps host blocks below it unaffected: ssh applies the first
  // value it sees, and an Include must not silently retarget an existing Host.
  const next = existing === '' ? `${block}\n` : `${block}\n\n${existing}`
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, next)
  return true
}

/**
 * Remove the include block, leaving every other line untouched.
 *
 * @param configPath - absolute path of `~/.ssh/config`.
 * @returns whether the file changed.
 */
export async function removeSshInclude(configPath) {
  let existing
  try {
    existing = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  const pattern = new RegExp(`${escapeRe(INCLUDE_BEGIN)}[\\s\\S]*?${escapeRe(INCLUDE_END)}\\n?`, 'gu')
  const next = existing.replace(pattern, '')
  if (next === existing) return false
  await writeFile(configPath, next)
  return true
}

/**
 * Generate an environment key pair.
 *
 * The name is fixed on purpose: replacing an environment's credential rewrites the
 * same file rather than accumulating copies, so the registered `sshKeyPath` stays
 * valid across rotations.
 *
 * @param options.keysRoot - directory holding per-environment key directories.
 * @param options.id - the environment id.
 * @returns the private key path, public key text and its fingerprint.
 */
export async function generateKey({ keysRoot, id }) {
  const dir = join(keysRoot, id)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const keyPath = join(dir, 'id_ed25519')
  // A previous key at this path is replaced: the fixed name is the contract, and a
  // caller rotating credentials expects the new key to take effect.
  await rm(keyPath, { force: true })
  await rm(`${keyPath}.pub`, { force: true })
  await runKeygen(keyPath)
  await chmod(keyPath, 0o600)
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
  await chmod(`${keyPath}.pub`, 0o644)
  return { keyPath, publicKey, fingerprint: fingerprintOf(publicKey) }
}

/** Absolute path of an environment's private key. */
export function keyPathFor(keysRoot, id) {
  return join(keysRoot, id, 'id_ed25519')
}

/**
 * Derive a short fingerprint from a public key line.
 *
 * Used as the identity shown to the operator, not as a security boundary: ssh
 * verifies the key itself.
 *
 * @param publicKey - the `ssh-ed25519 AAAA…` line.
 * @returns a base64url digest prefix.
 */
export function fingerprintOf(publicKey) {
  const body = publicKey.split(/\s+/u)[1] ?? ''
  return createHash('sha256').update(body).digest('base64url').slice(0, 16)
}

/**
 * Write one environment's ssh config fragment.
 *
 * @param options.sshConfigDir - the fragment directory.
 * @param options.alias - alias `dsh-ssh` uses as its host.
 * @param options.entry - the environment record.
 * @returns the fragment path.
 */
export async function writeSshFragment({ sshConfigDir, alias, entry }) {
  await mkdir(sshConfigDir, { recursive: true, mode: 0o700 })
  const path = join(sshConfigDir, `${entry.id}.conf`)
  await writeFile(path, renderSshConfig(entry, { alias }), { mode: 0o600 })
  return path
}

/** Remove one environment's fragment. */
export async function removeSshFragment({ sshConfigDir, id }) {
  await rm(join(sshConfigDir, `${id}.conf`), { force: true })
}

/**
 * Record a host key after the operator confirmed its fingerprint.
 *
 * `ssh-keyscan` output is appended verbatim; the caller decides whether the
 * fingerprint is the expected one. Appending rather than replacing keeps other
 * hosts' keys intact.
 *
 * @param options.knownHostsPath - absolute path of `known_hosts`.
 * @param options.host - host name or address.
 * @param options.port - port, when not 22.
 * @param options.expectedFingerprint - the value shown to and accepted by the operator.
 * @returns the fingerprints actually scanned.
 */
export async function trustHostKey({ knownHostsPath, host, port, expectedFingerprint }) {
  const args = ['-T', String(port ?? 22), host]
  const scanned = await run('ssh-keyscan', args)
  const lines = scanned.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length === 0) throw new Error(`daemon: ssh-keyscan returned no host key for ${host}`)
  const actual = fingerprintOfEd25519(lines)
  if (expectedFingerprint !== undefined && expectedFingerprint !== '' && actual !== expectedFingerprint) {
    throw new Error(`daemon: host key fingerprint ${actual} does not match the confirmed ${expectedFingerprint}`)
  }
  const existing = await readFile(knownHostsPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const merged = mergeKnownHosts(existing, lines)
  await mkdir(dirname(knownHostsPath), { recursive: true })
  await writeFile(knownHostsPath, merged, { mode: 0o644 })
  return { fingerprints: actual, added: merged !== existing }
}

/**
 * Append only the host keys not already present.
 *
 * Re-scanning a known host would otherwise add a duplicate line on every check.
 */
export function mergeKnownHosts(existing, lines) {
  const seen = new Set(existing.split('\n').map((line) => line.trim()).filter((line) => line !== ''))
  const out = existing === '' ? [] : existing.replace(/\n+$/u, '').split('\n')
  for (const line of lines) {
    if (seen.has(line)) continue
    out.push(line)
    seen.add(line)
  }
  return `${out.join('\n')}\n`
}

/**
 * Scan a host's keys without trusting them.
 *
 * @param options.host - host or address.
 * @param options.port - port, when not 22.
 * @returns the fingerprint of the ed25519 key, for the operator to compare.
 */
export async function scanHostKey({ host, port }) {
  const scanned = await run('ssh-keyscan', ['-T', String(port ?? 22), host])
  const lines = scanned.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  if (lines.length === 0) throw new Error(`daemon: ssh-keyscan returned no host key for ${host}`)
  return { fingerprint: fingerprintOfEd25519(lines), lines }
}

function fingerprintOfEd25519(lines) {
  const ed = lines.find((line) => line.includes(' ssh-ed25519 ')) ?? lines[0]
  return fingerprintOf(ed.split(' ').slice(2).join(' '))
}

/**
 * Install a public key on the remote host under a per-environment marker.
 *
 * The marker is what makes rotation safe: the old line is removed by exact match
 * before the new one is appended, so `authorized_keys` cannot accumulate keys
 * nobody can attribute.
 *
 * @param publicKey - the key line to install.
 * @param id - the environment id, used as the marker suffix.
 * @returns the shell command to run over SSH.
 */
export function installPublicKeyCommand(publicKey, id) {
  const marker = `dsh-daemon:${id}`
  const line = `${publicKey} ${marker}`
  const file = '$HOME/.ssh/authorized_keys'
  // Single-quoted heredoc content: the key line contains no quote, and the marker
  // keeps the removal pattern from matching a key installed by anything else.
  return [
    'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
    `touch ${file} && chmod 600 ${file}`,
    `grep -v '${marker}' ${file} > ${file}.dsh-tmp || true`,
    `cat ${file}.dsh-tmp > ${file} || true`,
    `rm -f ${file}.dsh-tmp`,
    `printf '%s\\n' '${line}' >> ${file}`,
    `grep -c '${marker}' ${file}`,
  ].join(' && ')
}

/**
 * Command that removes this environment's key line and reports the remainder.
 *
 * @param id - the environment id.
 * @returns the shell command.
 */
export function removePublicKeyCommand(id) {
  const marker = `dsh-daemon:${id}`
  const file = '$HOME/.ssh/authorized_keys'
  return [
    `if [ -f ${file} ]; then`,
    `grep -v '${marker}' ${file} > ${file}.dsh-tmp || true`,
    `cat ${file}.dsh-tmp > ${file} || true`,
    `rm -f ${file}.dsh-tmp`,
    'fi',
    `echo "${marker} removed"`,
  ].join(' ')
}

/** List key directories present on disk, for diagnostics. */
export async function listKeys(keysRoot) {
  try {
    const entries = await readdir(keysRoot, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** Whether a file exists. */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function run(command, args) {
  return new Promise((done, fail) => {
    execFile(command, args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        done(stdout)
        return
      }
      fail(new Error(`daemon: ${command} failed: ${(stderr || error.message).trim().slice(-400)}`))
    })
  })
}

function runKeygen(keyPath) {
  // `-N ''` keeps the key passphrase-free: the daemon cannot answer a prompt, and
  // dsh-ssh runs ssh with BatchMode.
  return run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'dsh-daemon', '-f', keyPath])
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
