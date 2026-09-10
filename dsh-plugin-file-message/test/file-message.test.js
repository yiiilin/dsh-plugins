import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import apply from '../index.js'

function createResponse() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
    destroy(error) {
      this.error = error
    },
  }
}

function createContext(root, extraSessions = []) {
  const sessionId = 'session-replay-test'
  const session = {
    id: sessionId,
    header: { id: sessionId, cwd: '/workspace' },
  }
  const extraHeaders = extraSessions.map(({ id }) => ({ id, cwd: '/workspace' }))
  const headers = [session.header, ...extraHeaders]
  const sessionRoots = new Map([
    [sessionId, root],
    ...extraSessions.map(({ id, root: sessionRoot }) => [id, sessionRoot]),
  ])
  let listCalls = 0
  const registered = new Map()
  const routes = []
  const target = { displayPath: '/workspace/result.png' }
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: '/workspace' }
      return undefined
    },
    sandboxPolicy: { workspaceRoot: '/workspace' },
    systemPrompt: { section() {} },
    tools: { register(tool) { registered.set(tool.name, tool) } },
    sessions: { get(id) { return id === sessionId ? session : undefined } },
    sessionPersistence: {
      locate(header) {
        const sessionRoot = sessionRoots.get(String(header.id))
        return sessionRoot === undefined ? undefined : { path: join(sessionRoot, 'session.jsonl.zstd') }
      },
      async list() {
        listCalls += 1
        return headers
      },
    },
    fs: {
      async resolve(value) {
        if (typeof value === 'string' && value === '/workspace') return { displayPath: '/workspace' }
        return target
      },
      async stat() {
        return { type: 'file', size: 12, version: 'version-1' }
      },
      contains() { return true },
      processPath() { return '/workspace/result.png' },
      async readBytes() { return new Uint8Array([137, 80, 78, 71]) },
    },
    emit() {},
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(register) {
      return register()
    },
  }
  apply(ctx)
  return { ctx, registered, routes, session, sessionId, listCalls: () => listCalls }
}

test('send_image persists session identity for replayable metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-message-test-'))
  try {
    const { registered, session, sessionId } = createContext(root)
    const callId = 'call-replay-test'
    const tool = registered.get('send_image')
    const value = await tool.execute({ file_path: 'result.png' }, {
      callId,
      agent: { session },
      signal: new AbortController().signal,
    })

    assert.equal(value.sessionId, sessionId)
    const meta = tool.output.presentationMeta({}, value)
    assert.equal(meta.sessionId, sessionId)

    const saved = JSON.parse(await readFile(join(root, 'send-attachments-metas.json'), 'utf8'))
    assert.equal(saved.items[callId].sessionId, sessionId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('content route recovers legacy metadata by callId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-message-test-'))
  try {
    const { registered, routes, session, sessionId } = createContext(root)
    const callId = 'call-legacy-replay-test'
    await registered.get('send_image').execute({ file_path: 'result.png' }, {
      callId,
      agent: { session },
      signal: new AbortController().signal,
    })

    const metaPath = join(root, 'send-attachments-metas.json')
    const saved = JSON.parse(await readFile(metaPath, 'utf8'))
    delete saved.items[callId].sessionId
    await writeFile(metaPath, `${JSON.stringify(saved)}\n`, 'utf8')

    const route = routes.find((candidate) => candidate.path === '/_dsh/file-message/content')
    const response = createResponse()
    await route.handler({ method: 'GET', url: `/?mode=meta&callId=${encodeURIComponent(callId)}` }, response)

    assert.equal(response.status, 200)
    const record = JSON.parse(response.body)
    assert.equal(record.callId, callId)
    assert.equal(record.sessionId, sessionId)
    assert.equal(record.path, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('caches legacy lookup and skips damaged unrelated sidecars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-message-test-'))
  const damagedRoot = await mkdtemp(join(tmpdir(), 'file-message-damaged-'))
  try {
    const sessionId = 'session-replay-test'
    const callId = 'call-indexed-legacy-test'
    await writeFile(join(root, 'send-attachments-metas.json'), `${JSON.stringify({
      version: 1,
      sessionId,
      items: {
        [callId]: {
          callId,
          toolName: 'send_image',
          kind: 'image',
          path: '/workspace/result.png',
          cwd: '/workspace',
          displayName: 'result.png',
          mediaType: 'image/png',
          size: 12,
          version: 'version-1',
        },
      },
    })}\n`, 'utf8')
    await writeFile(join(damagedRoot, 'send-attachments-metas.json'), '{not-json', 'utf8')

    const { routes, listCalls } = createContext(root, [{ id: 'session-damaged', root: damagedRoot }])
    const route = routes.find((candidate) => candidate.path === '/_dsh/file-message/content')

    const firstResponse = createResponse()
    await route.handler({ method: 'GET', url: `/?mode=meta&callId=${encodeURIComponent(callId)}` }, firstResponse)
    assert.equal(firstResponse.status, 200)
    assert.equal(JSON.parse(firstResponse.body).sessionId, sessionId)

    const secondResponse = createResponse()
    await route.handler({ method: 'GET', url: `/?mode=meta&callId=${encodeURIComponent(callId)}` }, secondResponse)
    assert.equal(secondResponse.status, 200)
    assert.equal(listCalls(), 1)

    const contentResponse = createResponse()
    await route.handler({ method: 'GET', url: `/?mode=preview&callId=${encodeURIComponent(callId)}` }, contentResponse)
    assert.equal(contentResponse.status, 400)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(damagedRoot, { recursive: true, force: true })
  }
})
