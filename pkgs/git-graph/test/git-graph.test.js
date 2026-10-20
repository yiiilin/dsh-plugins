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

test('the tab body reads its workspace from declared inject props only', async () => {
  // Two regressions meet here, and the fix for the first must not reintroduce the second.
  //
  // 1. `sidebar.right.pane.tab` renders a body with empty owner props, so a body that
  //    reads `props.useSessions` without declaring it through `inject` throws on first
  //    render and the tab appears to do nothing.
  // 2. Resolving the workspace from the global session list instead meant every
  //    workspace showed the same session's history. See the session-scoped test below.
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const body = client.slice(client.indexOf('function createFileExplorerGitPage'))
  // Comments explain both bugs and mention the offending expressions, so strip them
  // before looking for the dependency itself.
  const code = body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  assert.ok(!/props\.useSessions/u.test(code), 'the body must not read props.useSessions')
  assert.ok(!/props\.sessionId/u.test(code), 'the body must not read props.sessionId')
  assert.ok(
    !/remote\.session\.list\(/u.test(code),
    'the workspace must not come from the global session list',
  )
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

test('the git tab follows the session it is drawn in, not the busiest session', async () => {
  // The bug this pins: the body resolved its workspace by asking the session list for
  // the freshest session and taking its cwd. That list is global, so every workspace
  // showed whichever session had most recently been active — the same graph everywhere,
  // and switching workspaces changed nothing.
  //
  // The seat already declares `sidebar.right.pane.tab` as `{ kind: 'keyed', scope:
  // 'session' }`, so a body receives `sessionId` and the `useSessions` selector hook
  // without declaring anything. The product's own Files tab reads exactly that pair and
  // takes `sessions.byId[sessionId].cwd`.
  const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const body = client.slice(client.indexOf('function createFileExplorerGitPage'))
  const bodyCode = body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

  assert.match(
    bodyCode,
    /sessions\.byId\[sessionId\]\?\.cwd/u,
    'the body resolves its workspace from the session it is drawn in',
  )
  assert.ok(
    !/remote\.session\.list\(/u.test(bodyCode),
    'the body must not resolve a workspace from the global session list',
  )
})
