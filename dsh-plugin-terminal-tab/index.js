/**
 * dsh-plugin-terminal-tab — Host half.
 *
 * Each terminal owns a PTY and an independent WebSocket. The browser sends
 * xterm.js onData bytes to that socket; PTY output is broadcast only to the
 * sockets attached to the same terminal record.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const xtermEntry = require.resolve('@xterm/xterm')
const XTERM_SCRIPT = readFileSync(xtermEntry, 'utf8')
const XTERM_CSS = readFileSync(join(dirname(dirname(xtermEntry)), 'css', 'xterm.css'), 'utf8')

export const name = 'terminal-tab'
export const inject = ['webServer', 'agents']

const API_PREFIX = '/_dsh/terminal-tab'
const WS_PATH = `${API_PREFIX}/ws`
const MAX_SCROLLBACK = 262144

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req, limit = 262144) {
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    body += chunk
  }
  if (body.length === 0) return {}
  const value = JSON.parse(body)
  if (value === null || typeof value !== 'object') throw new Error('request body must be an object')
  return value
}

function statusSnapshot(status) {
  if (status && status.kind === 'exited') {
    return {
      kind: 'exited',
      exitCode: typeof status.exitCode === 'number' || status.exitCode === null ? status.exitCode : null,
      signal: typeof status.signal === 'string' || status.signal === null ? status.signal : null,
    }
  }
  return { kind: 'running' }
}

function sessionSnapshot(record) {
  const result = {
    sessionId: record.id,
    type: 'shell',
    pid: record.handle.pid,
    status: statusSnapshot(record.status),
  }
  if (typeof record.name === 'string' && record.name.length > 0) result.name = record.name
  return result
}

function readSnapshot(record) {
  const lines = record.output.length === 0 ? [] : record.output.split('\n')
  const end = lines.length
  const start = Math.max(0, end - 400)
  return {
    text: lines.slice(start, end).join('\n'),
    totalLines: lines.length,
    lineBegin: 0,
    lineEnd: end - start,
    truncated: record.truncated,
  }
}

function emptyRead() {
  return { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }
}

function ownerFor(agents, args) {
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : ''
  if (sessionId === '') throw new Error('missing sessionId')
  const owner = agents.get(sessionId)
  if (owner === undefined) throw new Error('session is no longer live')
  return owner
}

function subprocessFor(owner, rootSubprocess) {
  const scoped = owner.ctx && typeof owner.ctx.get === 'function' ? owner.ctx.get('subprocess') : undefined
  const service = scoped || rootSubprocess
  if (service === undefined) throw new Error('subprocess service is unavailable for this session')
  return service
}

function terminalId(args) {
  const id = args && typeof args.id === 'string' ? args.id : ''
  if (id === '') throw new Error('missing terminal id')
  return id
}

function terminalName(args) {
  if (!args || args.name === undefined) return undefined
  if (typeof args.name !== 'string') throw new Error('terminal name must be text')
  const name = args.name.trim()
  if (name.length > 80) throw new Error('terminal name is too long')
  return name.length === 0 ? undefined : name
}

function sessionCwd(owner) {
  const cwd = owner.session && owner.session.header && owner.session.header.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : '/'
}

function appendOutput(record, value) {
  const text = typeof value === 'string' ? value : record.decoder.decode(value, { stream: true })
  if (text.length === 0) return ''
  record.output += text
  if (record.output.length > MAX_SCROLLBACK) {
    record.output = record.output.slice(record.output.length - MAX_SCROLLBACK)
    record.truncated = true
  }
  return text
}

function sendSocket(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

function broadcast(record, value) {
  for (const socket of record.sockets) sendSocket(socket, value)
}

function rejectUpgrade(socket, status, reason) {
  const body = `${reason}\n`
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const agents = ctx.get('agents')
  const rootSubprocess = ctx.get('subprocess')
  if (webServer === undefined || agents === undefined) return

  const records = []
  const closing = []
  let nextId = 0
  const wss = new WebSocketServer({ noServer: true })

  const findRecord = (owner, args) => {
    const id = terminalId(args)
    const record = records.find((item) => item.owner === owner && item.id === id)
    if (record === undefined) throw new Error('terminal does not belong to this plugin or session')
    return record
  }

  const startTermination = (record) => {
    const task = Promise.resolve()
      .then(() => record.handle.terminate())
      .catch((error) => {
        ctx.logger?.warn?.('terminal-tab asynchronous cleanup failed: %s', error)
      })
    closing.push(task)
    task.then(() => {
      const index = closing.indexOf(task)
      if (index >= 0) closing.splice(index, 1)
    })
  }

  const writeToRecord = (record, data) => {
    record.writeChain = record.writeChain
      .then(() => record.handle.write(data))
      .catch((error) => {
        broadcast(record, { type: 'error', message: error && error.message ? error.message : String(error) })
      })
  }

  const attachWebSocket = (record, socket) => {
    record.sockets.add(socket)
    sendSocket(socket, { type: 'snapshot', data: record.output, status: statusSnapshot(record.status) })

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch (error) {
        sendSocket(socket, { type: 'error', message: 'invalid terminal websocket message' })
        return
      }
      if (message && message.type === 'input' && typeof message.data === 'string') {
        if (record.status.kind === 'exited') {
          sendSocket(socket, { type: 'error', message: 'terminal session has exited' })
          return
        }
        writeToRecord(record, message.data)
      } else if (message && message.type === 'signal' && typeof message.signal === 'string') {
        if (message.signal !== 'SIGINT' && message.signal !== 'SIGTERM' && message.signal !== 'SIGKILL' && message.signal !== 'SIGTSTP' && message.signal !== 'SIGHUP') return
        record.handle.signalForeground(message.signal).catch((error) => {
          sendSocket(socket, { type: 'error', message: error && error.message ? error.message : String(error) })
        })
      }
    })
    socket.on('close', () => record.sockets.delete(socket))
    socket.on('error', () => record.sockets.delete(socket))
  }

  const spawnRecord = async (owner, name) => {
    const handle = await subprocessFor(owner, rootSubprocess).spawnTerminal({
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      cwd: sessionCwd(owner),
      rows: 40,
      cols: 160,
      graceMs: 3000,
    })
    const record = {
      owner,
      id: `terminal-${++nextId}`,
      name,
      handle,
      decoder: new TextDecoder(),
      output: '',
      truncated: false,
      status: { kind: 'running' },
      sockets: new Set(),
      writeChain: Promise.resolve(),
    }
    handle.output.on('data', (chunk) => {
      const text = appendOutput(record, chunk)
      if (text !== '') broadcast(record, { type: 'output', data: text })
    })
    handle.output.on('end', () => {
      const text = appendOutput(record, record.decoder.decode())
      if (text !== '') broadcast(record, { type: 'output', data: text })
    })
    handle.done.then((outcome) => {
      const text = appendOutput(record, record.decoder.decode())
      if (text !== '') broadcast(record, { type: 'output', data: text })
      record.status = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
      broadcast(record, { type: 'exit', status: statusSnapshot(record.status) })
      for (const socket of record.sockets) socket.close(1000, 'terminal exited')
      record.sockets.clear()
    }, (error) => {
      record.status = { kind: 'exited', exitCode: null, signal: null }
      broadcast(record, { type: 'error', message: error && error.message ? error.message : String(error) })
      broadcast(record, { type: 'exit', status: statusSnapshot(record.status) })
    })
    records.push(record)
    await new Promise((resolve) => setTimeout(resolve, 120))
    return record
  }

  const route = (path, handler) => {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const args = await readJson(req)
          const result = await handler(args)
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: error && typeof error.message === 'string' ? error.message : String(error),
          })
        }
      },
    }), `terminal-tab route ${path}`)
  }

  const asset = (path, body, contentType) => {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': contentType,
          'cache-control': 'public, max-age=31536000, immutable',
          'content-length': Buffer.byteLength(body),
        })
        if (req.method === 'HEAD') res.end()
        else res.end(body)
      },
    }), `terminal-tab asset ${path}`)
  }

  asset(`${API_PREFIX}/xterm.js`, XTERM_SCRIPT, 'text/javascript; charset=utf-8')
  asset(`${API_PREFIX}/xterm.css`, XTERM_CSS, 'text/css; charset=utf-8')

  ctx.effect(() => webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      let url
      try {
        url = new URL(req.url || '', 'http://127.0.0.1')
      } catch (error) {
        rejectUpgrade(socket, 400, 'Bad Request')
        return
      }
      const owner = agents.get(url.searchParams.get('sessionId') || '')
      const record = owner === undefined ? undefined : records.find((item) => item.owner === owner && item.id === url.searchParams.get('terminalId'))
      if (record === undefined) {
        rejectUpgrade(socket, 404, 'Not Found')
        return
      }
      wss.handleUpgrade(req, socket, head, (websocket) => attachWebSocket(record, websocket))
    },
  }), `terminal-tab WebSocket ${WS_PATH}`)

  route(`${API_PREFIX}/list`, async (args) => {
    const owner = ownerFor(agents, args)
    return { sessions: records.filter((record) => record.owner === owner).map(sessionSnapshot) }
  })

  route(`${API_PREFIX}/spawn`, async (args) => {
    const owner = ownerFor(agents, args)
    const record = await spawnRecord(owner, terminalName(args))
    return { session: sessionSnapshot(record), motd: record.output }
  })

  route(`${API_PREFIX}/rename`, async (args) => {
    const owner = ownerFor(agents, args)
    const record = findRecord(owner, args)
    record.name = terminalName(args)
    return { session: sessionSnapshot(record) }
  })

  route(`${API_PREFIX}/read`, async (args) => {
    const owner = ownerFor(agents, args)
    const id = terminalId(args)
    const record = records.find((item) => item.owner === owner && item.id === id)
    return { read: record === undefined ? emptyRead() : readSnapshot(record) }
  })

  route(`${API_PREFIX}/kill`, async (args) => {
    const owner = ownerFor(agents, args)
    const record = findRecord(owner, args)
    for (const socket of record.sockets) socket.close(1000, 'terminal closed')
    record.sockets.clear()
    const index = records.indexOf(record)
    if (index >= 0) records.splice(index, 1)
    startTermination(record)
    return { closed: true }
  })

  ctx.effect(() => async () => {
    for (const record of records.slice()) {
      for (const socket of record.sockets) socket.terminate()
      record.sockets.clear()
      startTermination(record)
    }
    records.splice(0, records.length)
    await Promise.all(closing.slice())
    await new Promise((resolve) => wss.close(() => resolve()))
  }, 'terminal-tab PTY and WebSocket cleanup')
}
