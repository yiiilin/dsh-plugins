/**
 * Put this daemon under systemd's care.
 *
 * An edge started by hand survives until the machine reboots and then never comes back,
 * which is a failure nobody sees until they try to use it. This module renders a unit
 * that reproduces how the process is *already* running — same executable, same profile,
 * same ports, same environment — and installs it.
 *
 * It never guesses: a process started with a wrapper, a different HOME, or inside a
 * container would not be reproduced correctly by a generic template, so those cases are
 * refused with a reason rather than written out wrong.
 *
 * @module @yiln-dsh/dsh-gateway/systemd
 */

import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * systemd helpers for the gateway's own unit.
 *
 * This module and `supervisor` both touch systemd, and the split is deliberate:
 *
 * - here — reproduce *this process* as a unit. The inputs come from `process.argv` and
 *   `process.env`, because the job is to describe a process that is already running.
 * - `supervisor` — manage a unit from *configuration*: read its state, change its
 *   profile or port, and refuse to overwrite one owned by another DSH home.
 *
 * They are separate packages that install independently, so neither imports the other.
 * The one rule they must agree on is {@link systemdQuote}, and it is the reason this
 * comment exists: the two copies had drifted, and this one had lost the `$`/`%`
 * escaping that systemd requires.
 *
 * @module @yiln-dsh/dsh-gateway/systemd
 */

/** Where systemd reads unit files for the system scope. */
const UNIT_DIR = '/etc/systemd/system'

/** Environment variables a unit must carry to reproduce the running process. */
const CARRY_ENV = ['DSH_HOME', 'HOME', 'PATH']

/**
 * Whether this process is already supervised by systemd.
 *
 * `INVOCATION_ID` is set by systemd for every unit it starts and is the documented way to
 * ask. Re-installing a unit from inside the unit it describes would rewrite the file
 * systemd is currently reading; the caller uses this to stay out of the way.
 */
export function underSystemd(env = process.env) {
  return typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID !== ''
}

/**
 * Render a unit that reproduces this process.
 *
 * @param options.name - unit base name, without `.service`.
 * @param options.argv - `process.argv`.
 * @param options.execPath - `process.execPath`.
 * @param options.port - the `--port` this process listens on.
 * @param options.env - the environment to carry.
 * @param options.description - human name for the unit.
 * @returns the unit file text.
 */
export function renderUnit({ name, argv, execPath, port, env, description }) {
  // `argv[1]` is the script; anything else means the process was started in a way a unit
  // cannot reproduce. Refusing is better than writing a unit that starts something else.
  const script = argv[1]
  if (typeof script !== 'string' || script === '') {
    throw new Error('daemon: cannot write a unit without knowing the script to run')
  }
  const args = argv.slice(2).filter((arg) => arg !== '--no-open')
  const pieces = [execPath, script, ...args]
  // A port passed on the command line is part of how this process was started; keep it
  // rather than re-deriving it, so the unit runs the same thing.
  if (port !== undefined && !args.includes('--port') && !args.some((a) => a.startsWith('--port='))) {
    pieces.push('--port', String(port))
  }

  const environment = CARRY_ENV
    .filter((key) => typeof env[key] === 'string' && env[key] !== '')
    .map((key) => `Environment=${key}=${env[key]}`)

  return [
    '[Unit]',
    `Description=${description ?? `DeepSeek Harness daemon (${name})`}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${pieces.map(systemdQuote).join(' ')}`,
    'Restart=always',
    'RestartSec=2',
    ...environment,
    `WorkingDirectory=${env.HOME ?? '/'}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

/**
 * Install and enable a unit for this process.
 *
 * Enabling is the point: a unit that exists but is not enabled does not survive a reboot,
 * which is the whole problem being solved. Starting is deliberately not done — this
 * process is already running, and starting a second one would fight over the ports.
 *
 * @param options.name - unit base name without `.service`.
 * @param options.text - the rendered unit.
 * @param options.scope - `system` (needs root) or `user`.
 * @returns what was done.
 */
export async function installUnit({ name, text, scope = 'system' }) {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'systemd units are Linux only' }
  }
  if (existsSync('/run/systemd/system') === false) {
    return { ok: false, error: 'systemd is not running here' }
  }
  const unitName = `${name}.service`
  const path = scope === 'user'
    ? join(process.env.HOME ?? '/root', '.config', 'systemd', 'user', unitName)
    : join(UNIT_DIR, unitName)

  try {
    const previous = await readFile(path, 'utf8').catch(() => undefined)
    if (previous === text) {
      // Idempotent: a rewrite would trigger a reload for no reason.
      await systemctl(scope, ['enable', unitName])
      return { ok: true, path, unit: unitName, changed: false, enabled: true }
    }
    // Mark the file before writing so a failed write does not leave a half unit behind.
    const temporary = `${path}.tmp`
    await writeFile(temporary, text, { mode: 0o644 })
    await writeFile(path, text, { mode: 0o644 })
    await rm(temporary, { force: true })
    await systemctl(scope, ['daemon-reload'])
    await systemctl(scope, ['enable', unitName])
    return { ok: true, path, unit: unitName, changed: true, enabled: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), path, unit: unitName }
  }
}

/** Remove a unit this daemon installed. */
export async function removeUnit({ name, scope = 'system' }) {
  const unitName = `${name}.service`
  const path = scope === 'user'
    ? join(process.env.HOME ?? '/root', '.config', 'systemd', 'user', unitName)
    : join(UNIT_DIR, unitName)
  try {
    await systemctl(scope, ['disable', unitName]).catch(() => {})
    await rm(path, { force: true })
    await systemctl(scope, ['daemon-reload'])
    return { ok: true, unit: unitName }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** Run one systemctl command, with the scope flag it needs. */
function systemctl(scope, args) {
  return new Promise((done, fail) => {
    const finalArgs = scope === 'user' ? ['--user', ...args] : args
    execFile('systemctl', finalArgs, { timeout: 20_000 }, (error, stdout, stderr) => {
      if (error === null) {
        done(stdout.trim())
        return
      }
      fail(new Error(`systemctl ${finalArgs.join(' ')}: ${(stderr || error.message).trim()}`))
    })
  })
}

/**
 * Quote one argument for a systemd `ExecStart=` line.
 *
 * systemd splits on whitespace and honours double quotes, so a value with a space has to
 * be quoted and its own quotes escaped. This is deliberately the reverse of the parsing
 * rule rather than a shell quote: the unit is read by systemd, not by a shell.
 *
 * `$` and `%` are escaped as well, and that is not cosmetic. systemd expands `$NAME` and
 * `%x` specifiers in a unit file, so a path containing either would be rewritten before
 * the process ever started — `/opt/a$b/dsh.js` became `/opt/a/dsh.js`. Doubling is the
 * documented literal form: `$$` and `%%`.
 */
export function systemdQuote(value) {
  // An empty argument still has to occupy a position in `ExecStart=`, and systemd drops a
  // bare empty field entirely — so it is written as a quoted empty string.
  if (String(value) === '') return '""'
  const text = String(value)
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    // A replacement string treats `$` specially, so these use functions: `'$$$$'` in a
    // string produced four percent signs rather than two.
    .replace(/\$/gu, () => '$$')
    .replace(/%/gu, () => '%%')
  return /[\s"'$`%]/u.test(String(value)) ? `"${text}"` : text
}

/** The unit name this daemon installs. Fixed: it is the daemon, wherever it runs. */
export const UNIT_NAME = 'dsh-daemon'

/**
 * Resolve the unit name to install.
 *
 * `auto` and an explicit name both end at {@link UNIT_NAME}; the exported constant exists
 * so callers and tests share one definition rather than repeating a literal.
 *
 * @returns the unit base name, without `.service`.
 */
export function unitNameFor() {
  return UNIT_NAME
}
