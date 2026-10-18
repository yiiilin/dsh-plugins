import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { migrateProfilePatch } from './migration.mjs'

const [mode, file, ...extra] = process.argv.slice(2)
if (!['--check', '--write'].includes(mode) || !file || extra.length) {
  console.error('Usage: node scripts/migrate-profile.mjs --check|--write /absolute/profile/cordis.patch.yml')
  process.exitCode = 2
} else {
  const path = resolve(file)
  if (path !== file) throw new Error('Use an absolute canonical profile patch path')
  const run = async () => {
    const original = await readFile(path, 'utf8')
    const result = migrateProfilePatch(original)
    if (mode === '--write' && result.changes.length) await writeFileAtomic(path, result.content, { mode: 0o600, dirMode: 0o700 })
    console.log(JSON.stringify({ mode, changes: result.changes }))
  }
  if (mode === '--write') await withFileLock(path, run)
  else await run()
}
