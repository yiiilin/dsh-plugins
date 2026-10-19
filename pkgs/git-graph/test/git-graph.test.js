/**
 * Git Graph: the parts that can be wrong without a repository.
 *
 * This package had no tests at all, which is how its tab body shipped reading a prop the
 * seat never passes — the graph simply never appeared, with nothing failing anywhere.
 * The cases here decide whether a request is answered or rejected, plus one that pins the
 * tab body's dependency on its seat.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { __test, inject, name } from '../index.js'

const { cleanGitError, guessMime, isSafeCommitish, isSafeGitPath, parentOf } = __test

test('the plugin names itself and declares the one service it needs', () => {
  assert.equal(name, 'git-graph')
  assert.deepEqual(inject, ['webServer'])
})

test('git output is reduced to one readable line', () => {
  // git prefixes its diagnostics; the panel shows the message, not the prefix.
  assert.equal(cleanGitError('fatal: not a git repository', 'fallback'), 'not a git repository')
  assert.equal(cleanGitError('error: bad revision', 'fallback'), 'bad revision')
  assert.equal(cleanGitError('', 'fallback'), 'fallback')
  // Only the first line is kept: the panel has one line, and the first is the cause.
  assert.equal(cleanGitError('fatal: one\nfatal: two', 'fallback'), 'one')
})

test('a pathspec is refused when git could read it as an option', () => {
  // This guards `git diff -- <file>` only. Traversal is not its job: the repository
  // directory itself goes through `fs.resolve`, which is where policy applies, and a
  // pathspec is always interpreted inside the repository git runs in.
  assert.equal(isSafeGitPath('src/index.js'), true)
  assert.equal(isSafeGitPath('--output=/tmp/x'), false)
  assert.equal(isSafeGitPath(''), false)
  assert.equal(isSafeGitPath('a\nb'), false)
})

test('a commit argument must be a hash, not a ref or a flag', () => {
  // The route opens one commit by hash. A ref name is deliberately not accepted: the
  // browser never needs one, and refusing them keeps a flag from ever reaching git.
  assert.equal(isSafeCommitish('abc1234'), true)
  assert.equal(isSafeCommitish('a'.repeat(40)), true)
  assert.equal(isSafeCommitish('HEAD'), false)
  assert.equal(isSafeCommitish('main'), false)
  assert.equal(isSafeCommitish('--upload-pack=evil'), false)
})

test('a parent directory is computed without reaching the filesystem', () => {
  assert.equal(parentOf('/a/b/c'), '/a/b')
  // The root has no parent to offer; null rather than a wrong answer.
  assert.equal(parentOf('/'), null)
})

test('an unknown extension is served as bytes, never as something executable', () => {
  assert.equal(guessMime('x.js'), 'text/javascript')
  assert.equal(guessMime('x.PNG'), 'image/png')
  assert.equal(guessMime('x.unknown'), 'application/octet-stream')
})

test('the tab body never reads a prop the seat does not pass', async () => {
  // The regression this package shipped: `sidebar.right.pane.tab` injects only
  // `hooks.tabInfo` and `TabSlot` renders the body with empty props, so a body that reads
  // `props.useSessions` throws on first render and the tab appears to do nothing.
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const body = client.slice(client.indexOf('function createFileExplorerGitPage'))
  // Comments explain the old bug and mention the offending expression, so strip them
  // before looking for the dependency itself.
  const code = body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  assert.ok(!/props\.useSessions/u.test(code), 'the body must not read props.useSessions')
  // Nothing else may be read from the seat either: the Host half resolves the workspace
  // from the sandbox policy when a request carries no path.
  // The workspace comes from the session list through the closure, not from the seat.
  assert.match(code, /remote\.session\.list\(\)/u)
  assert.ok(!/props\.sessionId/u.test(code), 'the body must not read props.sessionId')
})

test('the Host still accepts a request that carries a path', async () => {
  // The browser supplies the session's cwd, but the Host must keep honouring an explicit
  // path: it is the only half that can resolve one through the filesystem service, and
  // the sandbox policy fallback is not a substitute — under full access that root is `/`,
  // which is not a repository.
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const resolveDir = source.slice(source.indexOf('const resolveDir = '), source.indexOf('const resolveRepo = '))
  assert.match(resolveDir, /typeof requestedPath === 'string' && requestedPath\.trim\(\) !== ''/u)
  assert.match(resolveDir, /fs\.resolve\(dir\)/u, 'and resolves it through the fs service')
})
