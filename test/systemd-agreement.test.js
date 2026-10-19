/**
 * The one systemd rule two independent packages must agree on.
 *
 * `gateway` and `supervisor` both write `ExecStart=` lines and both install on their own,
 * so neither can import the other. That makes `systemdQuote` a contract between them, and
 * the copies had already drifted once: one lost the `$`/`%` escaping entirely, and in the
 * other `'$$'` as a replacement string silently produced a single `$`.
 *
 * This test reads both implementations from source, evaluates them, and requires the same
 * answer for every case that matters.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { systemdQuote as fromGateway } from '../pkgs/gateway/lib/systemd.js'

const ROOT = new URL('../', import.meta.url)

/** Extract `function systemdQuote` from a file and evaluate it in isolation. */
async function loadQuote(relPath) {
  const source = await readFile(new URL(relPath, ROOT), 'utf8')
  const start = source.indexOf('function systemdQuote')
  assert.notEqual(start, -1, `${relPath}: no systemdQuote`)
  let depth = 0
  let end = source.indexOf('{', start)
  for (let i = end; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) { end = i + 1; break }
    }
  }
  // eslint-disable-next-line no-new-func -- evaluating one extracted function is the point
  return new Function(`${source.slice(start, end)}; return systemdQuote`)()
}

const CASES = [
  '/plain/path',
  '/with space/x',
  'a$b',
  'a%b',
  'a$%b',
  'a"b',
  'a\\b',
  'a`b',
]

test('both packages quote a systemd argument the same way', async () => {
  const fromSupervisor = await loadQuote('pkgs/supervisor/index.js')
  for (const value of CASES) {
    assert.equal(
      fromSupervisor(value),
      fromGateway(value),
      `the two implementations disagree on ${JSON.stringify(value)}`,
    )
  }
})

test('the shared answer escapes what systemd would otherwise expand', () => {
  // These are the two that had been lost, and both change the command systemd runs.
  assert.equal(fromGateway('a$b'), '"a$$b"')
  assert.equal(fromGateway('a%b'), '"a%%b"')
  // A value with neither is left alone, so a plain path stays readable in the unit file.
  assert.equal(fromGateway('/plain/path'), '/plain/path')
})
