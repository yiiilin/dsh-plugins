import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function createResponse() {
  let body = ''
  let statusCode
  return {
    response: {
      writeHead(status) {
        statusCode = status
      },
      end(value) {
        body = value || ''
      },
    },
    read() {
      return { statusCode, body: JSON.parse(body) }
    },
  }
}

function createHostContext(routes, subprocess) {
  const services = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    fs: {
      async resolve(path) {
        return path
      },
      processPath(path) {
        return path
      },
    },
    subprocess,
  }
  return {
    get(name) {
      return services[name]
    },
    effect(register) {
      register()
    },
  }
}

function createSubprocessService() {
  return {
    async resolveExecutable() {
      return 'git'
    },
    spawn({ argv, cwd }) {
      const result = execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: result, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', lossy: false }) },
        },
      }
    },
  }
}

test('git status expands every untracked file inside a directory', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-file-explorer-git-'))
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo })
    mkdirSync(join(repo, 'changes'))
    writeFileSync(join(repo, 'changes', 'one.txt'), 'one\n')
    writeFileSync(join(repo, 'changes', 'two.txt'), 'two\n')

    const routes = new Map()
    apply(createHostContext(routes, createSubprocessService()))
    const response = createResponse()
    await routes.get('/_dsh/file-explorer/git-status')({ method: 'GET', path: repo }, response.response)

    const result = response.read()
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual(result.body.entries, [
      { status: '?', path: 'changes/one.txt' },
      { status: '?', path: 'changes/two.txt' },
    ])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
