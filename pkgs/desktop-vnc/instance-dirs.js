/**
 * desktop-vnc Host half — the temp-directory identity of one browser instance,
 * and the startup sweep that clears what a dead process left behind.
 *
 * Each instance keeps its Chromium profile and its Xauthority cookie in
 * `$TMPDIR/dsh-desktop-vnc-<pid>-<bootId>-<seq>`. Two properties are load-bearing:
 *
 * - **A name is never reused across process starts.** A sequence number alone
 *   restarts at 1 in every process, so the first instance of a restarted dsh
 *   landed in the directory a crashed process had left behind — inheriting its
 *   `profile/SingletonLock` and its stale Xauthority — and Chromium refused to
 *   start. The pid alone is not enough either: pids are recycled. The name
 *   therefore carries a per-start `bootId` as well, and `seq` only has to be
 *   unique *within* one start.
 * - **The sweep never guesses.** Only a directory whose name parses *and* whose
 *   owning pid is provably gone is removed. A legacy `dsh-desktop-vnc-<number>`
 *   directory cannot prove its owner is dead (the number may be a pid, an
 *   instance sequence, or another version's idea of either), so it is left alone:
 *   leaking a stale profile costs a few kilobytes, while deleting a live one
 *   kills somebody else's browser.
 *
 * Both the filesystem and the pid liveness check are injected, so tests neither
 * touch the real `/tmp` nor signal a real process.
 *
 * @module @yiln-dsh/dsh-desktop-vnc/instance-dirs
 */

import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The prefix every directory this plugin owns starts with. */
export const INSTANCE_DIR_PREFIX = 'dsh-desktop-vnc-'

/** The prefix as a pattern: a name is ours only when it parses below. */
const NAME_PATTERN = /^dsh-desktop-vnc-(\d+)-(\d+)-(\d+)$/u

/**
 * The directory name of one browser instance.
 *
 * @param {{pid: number, bootId: number, sequence: number}} key the instance identity.
 * @returns {string} the directory name (not a path).
 */
export function instanceDirName({ pid, bootId, sequence }) {
  return `${INSTANCE_DIR_PREFIX}${pid}-${bootId}-${sequence}`
}

/**
 * Read a directory name back into the identity that produced it.
 *
 * Strict on purpose: anything this plugin did not mint — including the legacy
 * single-number form an older version wrote — answers `null`, and a name that
 * does not parse is never deleted.
 *
 * @param {string} name one entry name from the temp directory.
 * @returns {{pid: number, bootId: number, sequence: number}|null} the identity, or null.
 */
export function parseInstanceDirName(name) {
  if (typeof name !== 'string') return null
  const match = NAME_PATTERN.exec(name)
  if (match === null) return null
  const [pid, bootId, sequence] = match.slice(1).map((part) => Number(part))
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(bootId) || !Number.isSafeInteger(sequence)) return null
  if (pid <= 0 || bootId < 0 || sequence <= 0) return null
  return { pid, bootId, sequence }
}

/**
 * The moment this module loaded: the process-start identity used in every key.
 *
 * Module load happens once per process, so every keyer built in one process
 * shares it — which is what makes two plugin mounts in that process agree that
 * they are the same start, and disagree with any other start.
 */
const BOOT_ID = Date.now()

/**
 * The last sequence handed out, per process. Global on purpose: even two mounts of
 * this plugin inside one process must not mint the same directory, because two
 * instances sharing a directory share a Chromium `SingletonLock` and an
 * Xauthority cookie (last writer wins, first browser locked out of its display).
 */
let bootSequence = 0

/**
 * Mint instance directory keys for one process start.
 *
 * A key is `<pid>-<bootId>-<seq>`:
 *
 * - `bootId` is a per-start stamp, not a counter, so a *restarted* process cannot
 *   reissue the key a crashed one used (`dsh-desktop-vnc-1` was that bug);
 * - `pid` separates two dsh processes that started in the same millisecond;
 * - `seq` is unique inside one process, however many keyers it builds.
 *
 * @param {{pid?: number, bootId?: number}} [options] identity overrides, for tests.
 * @returns {() => string} a minting function answering one fresh key per instance.
 */
export function newInstanceKeyer({ pid = process.pid, bootId = BOOT_ID } = {}) {
  return () => {
    bootSequence += 1
    return `${pid}-${bootId}-${bootSequence}`
  }
}

/**
 * Does `pid` still exist?
 *
 * Signal 0 asks the kernel without delivering anything. `EPERM` means the process
 * exists but belongs to another user, which is still "alive" — treating it as dead
 * would delete a running profile.
 *
 * @param {number} pid the process id to test.
 * @returns {boolean} true when a process with that id exists.
 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Remove the instance directories of processes that no longer exist.
 *
 * best-effort by contract: an unreadable temp directory, an unparsable name, a
 * failed `rm` and an inconclusive liveness check all simply leave the directory
 * in place — none of them may block the plugin mounting.
 *
 * The current process's own directories are kept too. They cannot be stale (they
 * belong to a live pid), and a caller mounting the plugin twice would otherwise
 * delete the instances it just created.
 *
 * @param {object} [options]
 * @param {string} [options.tmpDir] directory to sweep.
 * @param {number} [options.ownPid] the process doing the sweeping.
 * @param {(pid: number) => boolean} [options.isAlive] liveness probe, for tests.
 * @param {() => Promise<Array<{name: string, isDirectory: () => boolean}>>} [options.scan]
 *   directory listing, for tests.
 * @param {(path: string) => Promise<void>} [options.remove] directory removal, for tests.
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @returns {Promise<string[]>} the names that were removed.
 */
export async function cleanStaleInstanceDirs({
  tmpDir = undefined,
  ownPid = process.pid,
  isAlive = defaultIsAlive,
  scan = undefined,
  remove = async (path) => rm(path, { recursive: true, force: true }),
  log,
} = {}) {
  // An omitted base means "this machine's temp directory", the same default
  // `cleanStaleInstanceDirs` is called with in production (`tmpdir()`), so a
  // caller that leaves the option out still sweeps something real.
  const base = typeof tmpDir === 'string' && tmpDir !== '' ? tmpDir : tmpdir()
  const list = typeof scan === 'function' ? scan : async () => readdir(base, { withFileTypes: true })
  const note = (level, message) => {
    if (typeof log !== 'function') return
    try {
      log(level, message)
    } catch {
      // Diagnostics must never break the sweep.
    }
  }

  let entries
  try {
    entries = await list(base)
  } catch (error) {
    // An unreadable temp directory is not a startup failure.
    note('info', `desktop-vnc: cannot scan ${base ?? 'the temp directory'} for stale instances: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }

  const removed = []
  for (const entry of entries ?? []) {
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue
    const identity = parseInstanceDirName(entry.name)
    if (identity === null) continue
    if (identity.pid === ownPid) continue

    let alive
    try {
      alive = isAlive(identity.pid) === true
    } catch {
      // An inconclusive probe is treated as alive: leaking beats deleting.
      alive = true
    }
    if (alive) continue

    const path = base === undefined ? entry.name : join(base, entry.name)
    try {
      await remove(path)
      removed.push(entry.name)
    } catch (error) {
      note('warn', `desktop-vnc: cannot remove the stale instance directory ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (removed.length > 0) {
    note('info', `desktop-vnc: removed ${removed.length} stale instance director${removed.length === 1 ? 'y' : 'ies'}: ${removed.join(', ')}`)
  }
  return removed
}
