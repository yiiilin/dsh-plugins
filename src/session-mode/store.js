import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { MODES, SESSION_ID, modeError, validatePolicy } from './policy.js'

export function defaultStateDir(profileContext) {
  const home = resolve(profileContext?.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profile = profileContext?.dir || process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default'
  const key = createHash('sha256').update(profile).digest('hex').slice(0, 24)
  return join(home, 'session-modes', key)
}

export function createPolicyStore(directory, { write = writeFileAtomic } = {}) {
  if (!isAbsolute(directory)) throw new TypeError('Session mode stateDir must be absolute')
  const pathFor = (id) => {
    if (!SESSION_ID.test(id)) throw modeError('invalid_session', 'Invalid session identity')
    return join(directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }
  const read = async (id) => {
    try { return validatePolicy(JSON.parse(await readFile(pathFor(id), 'utf8')), id) }
    catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }
  const locked = async (id, operation) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return withFileLock(pathFor(id), operation)
  }
  const save = (id, policy) => write(pathFor(id), `${JSON.stringify(policy)}\n`, { mode: 0o600, dirMode: 0o700 })
  return {
    pathFor, read,
    ensure(id, mode) {
      if (!MODES.includes(mode)) throw modeError('invalid_mode', 'Invalid session mode')
      return locked(id, async () => {
        const existing = await read(id)
        if (existing) return existing
        const policy = validatePolicy({ version: 1, sessionId: id, mode, revision: 0 }, id)
        await save(id, policy)
        return policy
      })
    },
    set(id, mode, revision, check = () => {}) {
      if (!MODES.includes(mode)) throw modeError('invalid_mode', 'Invalid session mode')
      return locked(id, async () => {
        const existing = await read(id)
        if (!existing || existing.revision !== revision) throw modeError('conflict', 'Session mode changed; reload before saving.')
        check()
        const next = validatePolicy({ ...existing, mode, revision: existing.revision + 1 }, id)
        await save(id, next)
        return next
      })
    },
  }
}
