/**
 * Every module must load, and every name it uses must exist.
 *
 * The unit tests exercised the helpers directly, so a missing `import` in `index.js`
 * only appeared when a real daemon called the tool: the workspace read threw
 * "listWorkspaces is not defined". Importing the entry point here is cheap and would
 * have caught it.
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const ROOT = new URL('../', import.meta.url)

test('every module in the package imports cleanly', async () => {
  const files = ['index.js', 'tools.js']
  for (const dir of ['lib', 'lib/federation']) {
    for (const name of await readdir(new URL(`${dir}/`, ROOT))) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`)
    }
  }
  for (const file of files) {
    await import(new URL(file, ROOT))
  }
  assert.ok(files.length >= 10, `expected the whole package, walked ${files.join(', ')}`)
})

test('the entry point uses names it actually imports', async () => {
  // A missing import is a ReferenceError at call time, which no unit test reaches when
  // the helper itself is imported directly by the test.
  const source = await readFile(new URL('index.js', ROOT), 'utf8')
  for (const name of ['listWorkspaces', 'listSessions', 'readForTransfer', 'writeFromTransfer', 'deliverToSession']) {
    const used = new RegExp(`\\b${name}\\(`, 'u').test(source)
    if (!used) continue
    const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`, 'u').test(source)
    assert.ok(imported, `${name} is used but not imported in index.js`)
  }
})
