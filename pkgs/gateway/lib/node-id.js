/**
 * This node's own identity.
 *
 * Every node in a federation needs one stable id, and it has to be the *same kind* of id
 * everywhere — otherwise a table full of ids is a table of things nobody can compare. The
 * main node used to identify itself by its listen address (`0.0.0.0:3080`), which is not
 * an identity: it changes when the port does, it is meaningless to any other machine, and
 * it sits in a different namespace from the ids the registry hands out. An edge reading
 * that row could not tell it was looking at the node it was connected to.
 *
 * So the id is generated once, written beside the registry, and read back on every start.
 * It never derives from the label, the hostname or the port — a machine that moves keeps
 * the name its peers already know.
 *
 * @module @yiln-dsh/dsh-gateway/lib/node-id
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ID_PATTERN } from './registry.js'

/** File name within the daemon directory, one per profile: several share a home. */
const fileFor = (profile) => `node-id${profile === '' ? '' : `-${profile}`}`

/**
 * Read this node's id, creating it on first use.
 *
 * A malformed or unreadable file is replaced rather than trusted: a corrupt id would put
 * a bad route prefix on every URL this node advertises.
 *
 * @param options.daemonDir - directory holding the daemon's own state.
 * @param options.configured - an explicit id from configuration; takes precedence when valid.
 * @param options.profile - the profile this node serves; ids are per profile.
 * @returns the id, or `''` when neither a file nor a directory is available.
 */
export async function ensureNodeId({ daemonDir, configured = '', profile = '' }) {
  const asked = String(configured ?? '').trim()
  if (asked !== '' && ID_PATTERN.test(asked)) return asked

  if (daemonDir === '') return ''
  // A profile suffix, because every profile on a machine shares one daemon directory. Two
  // profiles reading the same file would introduce themselves to the federation under one
  // id, and every route to either of them would land on whichever answered first.
  const path = join(daemonDir, fileFor(profile))

  try {
    const held = (await readFile(path, 'utf8')).trim()
    if (ID_PATTERN.test(held)) return held
  } catch {
    // Absent is the normal first-run case.
  }

  const created = `n${randomBytes(9).toString('hex').slice(0, 16)}`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${created}\n`, { mode: 0o600 })
  } catch {
    // A node that cannot persist still works for this run; it just may not keep the name.
  }
  return created
}
