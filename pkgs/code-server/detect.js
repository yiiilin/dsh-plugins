/**
 * Environment detection for the host-installed code-server binary.
 *
 * The plugin never ships code-server. It asks the `subprocess` service whether
 * the configured executable resolves, and optionally asks that binary for its
 * version. Everything is best-effort: a missing binary, a failing version
 * probe or an absent subprocess service must leave the plugin mounted and the
 * panel able to show a setup guide, not take the Harness down.
 *
 * @module @yiln-dsh/dsh-code-server/detect
 */

import { tmpdir } from 'node:os'

/** Read a collected output stream from a finished subprocess handle. */
function collectedText(handle, stream) {
  const reader = handle?.collected?.[stream]
  if (reader === undefined || reader === null) return ''
  try {
    return reader.readFrom(0).text.trim()
  } catch {
    return ''
  }
}

/**
 * Ask the subprocess service where the configured executable lives.
 *
 * @param {object} options
 * @param {Function} [options.resolveExecutable] `subprocess.resolveExecutable`.
 * @param {string} options.executable configured command name or path.
 * @returns {Promise<string|null>} the resolved path, or null when absent.
 */
export async function resolveExecutablePath({ resolveExecutable, executable }) {
  if (typeof resolveExecutable !== 'function' || typeof executable !== 'string' || executable === '') return null
  try {
    const path = await resolveExecutable(executable)
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

/**
 * The shape `code-server --version` prints: `<semver> <commit> with Code <semver>`.
 *
 * Matching the shape rather than "the first line" is what keeps a first-run
 * "Wrote default config file…" info line from being reported as the version.
 */
const VERSION_LINE = /^\d+\.\d+\.\d+\S*\s+[0-9a-f]{7,}\b/iu

/**
 * Run `<executable> --version` once, bounded by the subprocess service.
 *
 * @param {object} options
 * @param {Function} [options.spawn] `subprocess.spawn`.
 * @param {string} options.executablePath resolved executable path.
 * @param {string} [options.cwd] working directory for the probe.
 * @returns {Promise<string|null>} the first version line, or null.
 */
export async function readVersion({ spawn, executablePath, cwd = tmpdir() }) {
  if (typeof spawn !== 'function' || typeof executablePath !== 'string' || executablePath === '') return null
  let handle
  try {
    handle = spawn({
      argv: [executablePath, '--version'],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192 },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 2000,
    })
  } catch {
    return null
  }
  try {
    const outcome = await handle.done
    if (outcome?.exitCode !== 0) return null
    const text = collectedText(handle, 'stdout') || collectedText(handle, 'stderr')
    // `code-server --version` prints an info line on first run ("Wrote default
    // config file…") before the version, and that line may land on either
    // stream. Taking the first non-empty line therefore reported the log line
    // as the version. Match the real shape instead: `<semver> <commit> with
    // Code <semver>` (the tail is optional in older builds).
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (VERSION_LINE.test(trimmed)) return trimmed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Detect whether code-server is usable on this host.
 *
 * @param {object} options
 * @param {string} options.executable configured command name or path.
 * @param {Function} [options.resolveExecutable] `subprocess.resolveExecutable`.
 * @param {Function} [options.spawn] `subprocess.spawn`.
 * @param {string} [options.cwd] working directory for the version probe.
 * @returns {Promise<{installed: boolean, executable: string, path: string|null, version: string|null}>}
 */
export async function detect({ executable, resolveExecutable, spawn, cwd = tmpdir() }) {
  const path = await resolveExecutablePath({ resolveExecutable, executable })
  if (path === null) {
    return { installed: false, executable, path: null, version: null }
  }
  const version = await readVersion({ spawn, executablePath: path, cwd })
  return { installed: true, executable, path, version }
}
