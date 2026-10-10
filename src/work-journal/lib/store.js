/**
 * Durable storage for the work-journal index.
 *
 * The index is derived data: it can always be rebuilt from the session store,
 * so nothing here needs a transaction, a schema migration, or a backup story.
 * It does need two things, though. It must never be observed half-written — a
 * truncated JSON document would make every later query fail until someone
 * noticed — and it must not lose the day buckets that reports are built from.
 *
 * `writeFileAtomic` covers the first: content lands on a fresh inode that is
 * renamed over the target, so a reader sees either the previous complete index
 * or the next one. The second is why the index is written whole rather than
 * appended: the document is small (a few hundred kilobytes for hundreds of
 * sessions) and a whole-document write is the only shape that cannot leave a
 * partially updated activity behind.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { adoptIndex, emptyIndex } from './collector.js'

/**
 * Default directory for the index, scoped per profile.
 *
 * Two profiles sharing one index would mix two deployments' sessions, and the
 * timezone is baked into the buckets, so the key covers both.
 * @param profileContext - optional `{ home, dir }` from the plugin context.
 * @param tzOffsetMinutes - the offset the index is bucketed in.
 * @returns an absolute directory path.
 */
export function defaultIndexDir(profileContext, tzOffsetMinutes) {
  const home = resolve(profileContext?.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profile = profileContext?.dir || process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default'
  const key = createHash('sha256').update(`${profile}\0${tzOffsetMinutes}`).digest('hex').slice(0, 24)
  return join(home, 'work-journal', key)
}

/**
 * Create the index store.
 * @param directory - absolute directory holding `index.json`.
 * @param options - injectable `read`/`write` for tests.
 * @returns the store handle.
 */
export function createIndexStore(directory, options = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new TypeError('work-journal indexDir must be an absolute path')
  }
  const path = join(directory, 'index.json')
  const readFileImpl = options.readFile ?? readFile
  const writeFileImpl = options.write ?? writeFileAtomic

  const load = async (tzOffsetMinutes) => {
    try {
      const raw = await readFileImpl(path, 'utf8')
      return adoptIndex(JSON.parse(raw), tzOffsetMinutes)
    } catch (error) {
      // A missing index is the normal first-run state. Anything else — a
      // truncated document, a JSON syntax error — is also recoverable, because
      // the next scan rebuilds it from the session store.
      if (error?.code !== 'ENOENT') {
        options.onWarning?.(`work-journal: discarding unreadable index at ${path}: ${error.message}`)
      }
      return emptyIndex(tzOffsetMinutes)
    }
  }

  const save = async (index) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFileImpl(path, `${JSON.stringify(index)}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  return { path, load, save }
}
