/**
 * Unit tests for the screenshot path: JPEG validation, the argv handed to
 * ImageMagick, readable failure messages, multipart framing and — the property
 * that matters most — the MJPEG timer actually stopping when the client goes.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  MAX_FPS,
  clampInt,
  createCaptureService,
  describeCaptureError,
  importArgv,
  isJpeg,
  safeDisplay,
  streamMjpeg,
} from '../capture.js'

/** A minimal JPEG: SOI, some payload, EOI. */
function jpegBytes(marker = 0x00, size = 64) {
  const body = Buffer.alloc(size, marker)
  body[0] = 0xff
  body[1] = 0xd8
  body[size - 2] = 0xff
  body[size - 1] = 0xd9
  return body
}

/** A fake subprocess handle that emits `body` on stdout and then exits. */
function fakeHandle({ body = jpegBytes(), exitCode = 0 } = {}) {
  const stdout = new EventEmitter()
  stdout.destroy = () => {}
  stdout.removeAllListeners = stdout.removeAllListeners.bind(stdout)
  const handle = {
    pid: 1,
    stdout,
    terminated: 0,
    stderrText: '',
  }
  handle.done = Promise.resolve({ exitCode, signal: null })
  handle.terminate = () => {
    handle.terminated += 1
  }
  handle.waitForExit = () => Promise.resolve(true)
  handle.collected = {
    stderr: { readFrom: () => ({ text: handle.stderrText, nextOffset: 0, lossy: false }) },
  }
  // Emit after the caller has attached its reader (drain attaches on the next tick).
  setImmediate(() => {
    if (body.length > 0) stdout.emit('data', body)
    stdout.emit('end')
  })
  return handle
}

/** A fake HTTP response recording everything written to it. */
function fakeResponse() {
  const res = new EventEmitter()
  res.chunks = []
  res.head = null
  res.ended = false
  res.destroyed = false
  res.req = new EventEmitter()
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
    return res
  }
  res.write = (chunk) => {
    res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }
  res.end = () => {
    res.ended = true
    return res
  }
  res.body = () => Buffer.concat(res.chunks)
  return res
}

test('clampInt keeps client input inside the route bounds', () => {
  assert.equal(clampInt('50', 1, 100, 72), 50)
  assert.equal(clampInt('0', 1, 100, 72), 1)
  assert.equal(clampInt('9000', 1, 100, 72), 100)
  assert.equal(clampInt(undefined, 1, 100, 72), 72)
  assert.equal(clampInt('abc', 1, 100, 72), 72)
  assert.equal(clampInt('30', 1, MAX_FPS, 8), 15)
})

test('safeDisplay refuses anything that could read as a flag', () => {
  assert.equal(safeDisplay(':0'), ':0')
  assert.equal(safeDisplay(':10'), ':10')
  assert.equal(safeDisplay(' :1 '), ':1')
  assert.equal(safeDisplay('--help'), ':0')
  assert.equal(safeDisplay(':0; rm -rf /'), ':0')
  assert.equal(safeDisplay(undefined), ':0')
  assert.equal(safeDisplay(''), ':0')
})

test('isJpeg rejects truncated and non-JPEG bodies', () => {
  assert.equal(isJpeg(jpegBytes()), true)
  assert.equal(isJpeg(Buffer.from([0xff, 0xd8])), false)
  assert.equal(isJpeg(Buffer.from('not an image')), false)
  const truncated = jpegBytes().subarray(0, 60)
  assert.equal(isJpeg(truncated), false)
  assert.equal(isJpeg(undefined), false)
})

test('the import argv targets the configured display root window', () => {
  const argv = importArgv('/usr/bin/import', { display: ':0', quality: 72 })
  assert.deepEqual(argv, ['/usr/bin/import', '-display', ':0', '-window', 'root', '-quality', '72', 'jpeg:-'])
})

test('capture returns the raw JPEG bytes import produced', async () => {
  const body = jpegBytes(0x7f, 128)
  const specs = []
  const service = createCaptureService({
    spawn: (spec) => {
      specs.push(spec)
      return fakeHandle({ body })
    },
    resolveExecutable: async () => '/usr/bin/import',
    config: { display: ':0', jpegQuality: 72 },
  })

  const frame = await service.capture({ quality: 50 })
  assert.deepEqual(frame, body)
  assert.equal(specs.length, 1)
  // argv = [exe, -display, :0, -window, root, -quality, <q>, jpeg:-]
  assert.equal(specs[0].argv[6], '50')
  // JPEG is not valid UTF-8: the frame must arrive as a raw stream.
  assert.equal(specs[0].stdio.stdout, 'pipe')
})

test('draining stdout must not detach the child-process internal listener', async () => {
  // Regression: `drain` used to call `stream.removeAllListeners()`, which also
  // strips the listener Node attaches to a piped ChildProcess stream. The child
  // then never emitted `close`, so `handle.done` hung until the capture timeout
  // and every frame.jpg request answered 503 after ~8s.
  const { spawn: nodeSpawn } = await import('node:child_process')

  const frame = jpegBytes(0x5a, 64)
  const script = `process.stdout.write(Buffer.from(${JSON.stringify(frame.toString('base64'))}, 'base64'))`

  const service = createCaptureService({
    spawn() {
      const child = nodeSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderrText = ''
      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString()
      })
      return {
        pid: child.pid,
        stdout: child.stdout,
        done: new Promise((resolve) => {
          child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
        }),
        terminate: () => child.kill('SIGTERM'),
        waitForExit: () => new Promise((resolve) => child.on('close', () => resolve(true))),
        collected: { stderr: { readFrom: () => ({ text: stderrText, nextOffset: 0, lossy: false }) } },
      }
    },
    resolveExecutable: async () => process.execPath,
    config: { display: ':0' },
    timeoutMs: 4000,
  })

  // With the internal listener stripped this rejects with a timeout instead.
  const body = await service.capture()
  assert.deepEqual(body, frame)
})

test('capture rejects when import exits non-zero, with a readable reason', async () => {
  const handle = fakeHandle({ body: Buffer.alloc(0), exitCode: 1 })
  handle.stderrText = 'import: unable to open X server `:0`\n'
  const service = createCaptureService({
    spawn: () => handle,
    resolveExecutable: async () => '/usr/bin/import',
    config: { display: ':0' },
  })

  await assert.rejects(() => service.capture(), /unable to open X server/)
})

test('capture rejects a body that is not a complete JPEG', async () => {
  const service = createCaptureService({
    spawn: () => fakeHandle({ body: Buffer.from('this is not a jpeg') }),
    resolveExecutable: async () => '/usr/bin/import',
    config: { display: ':0' },
  })

  // A zero exit with a non-JPEG body is still a failed capture, never a corrupt frame.
  await assert.rejects(() => service.capture(), /no usable JPEG frame/)
})

test('a missing import binary is reported as not installed', async () => {
  const service = createCaptureService({
    spawn: () => fakeHandle(),
    resolveExecutable: async () => {
      const error = new Error('not found on PATH')
      error.code = 'ENOENT'
      throw error
    },
    config: { display: ':0' },
  })

  await assert.rejects(() => service.capture(), /未安装/)
})

test('capture failures never leak a stack trace', () => {
  assert.equal(describeCaptureError(new Error('boom\n    at foo (bar.js:1:1)')), 'boom')
  assert.match(describeCaptureError({ code: 'ENOENT' }), /未安装/)
  assert.equal(describeCaptureError(undefined), 'desktop capture failed')
})

test('the MJPEG stream frames each capture as multipart with its length', async () => {
  const frame = jpegBytes(0x22, 48)
  const res = fakeResponse()
  const stream = streamMjpeg({
    res,
    capture: async () => frame,
    fps: 15,
    quality: 60,
  })

  // Let the immediate first frame land, then stop before more arrive.
  await new Promise((resolve) => setTimeout(resolve, 5))
  stream.stop()

  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^multipart\/x-mixed-replace; boundary=/)
  assert.equal(res.headers['cache-control'].includes('no-store'), true)

  const body = res.body()
  assert.ok(body.includes(Buffer.from(`--${stream.boundary}\r\n`)), 'boundary delimiter present')
  assert.ok(body.includes(Buffer.from('content-type: image/jpeg\r\n')), 'part header present')
  assert.ok(body.includes(Buffer.from(`content-length: ${frame.length}\r\n\r\n`)), 'declared length matches')
  assert.ok(body.includes(frame), 'the JPEG itself is written verbatim')
})

test('closing the response stops the MJPEG timer', async () => {
  let captures = 0
  const res = fakeResponse()
  const stream = streamMjpeg({
    res,
    capture: async () => {
      captures += 1
      return jpegBytes()
    },
    fps: 15,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  const afterFirst = captures
  // The browser goes away: this is the event the route must honour.
  res.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 90))

  assert.equal(stream.started, false)
  assert.equal(captures, afterFirst, 'no capture may run after the client closed')
})

test('an aborted request stops the MJPEG timer', async () => {
  let captures = 0
  const res = fakeResponse()
  streamMjpeg({
    res,
    capture: async () => {
      captures += 1
      return jpegBytes()
    },
    fps: 15,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  const afterFirst = captures
  res.req.emit('aborted')
  await new Promise((resolve) => setTimeout(resolve, 90))

  assert.equal(captures, afterFirst)
})

test('a capture failure ends the stream instead of spinning', async () => {
  const res = fakeResponse()
  const stream = streamMjpeg({
    res,
    capture: async () => {
      throw new Error('display went away')
    },
    fps: 15,
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stream.started, false)
  assert.equal(res.ended, true)
})

test('a failing frame is not written and the deferred frames contain valid parts', async () => {
  let call = 0
  const good = jpegBytes(0x33, 32)
  const res = fakeResponse()
  const stream = streamMjpeg({
    res,
    capture: async () => {
      call += 1
      if (call === 2) throw new Error('transient failure')
      return good
    },
    fps: 15,
  })

  await new Promise((resolve) => setTimeout(resolve, 5))
  stream.stop()
  // A failure stops the stream, so at most the first good frame plus its headers exist.
  assert.ok(call >= 1)
  assert.equal(res.body().includes(good), call === 1)
})

// --- v2: the captured display is retargeted to the nested one ----------------

test('setDisplay() retargets later captures without a restart', async () => {
  const specs = []
  const service = createCaptureService({
    spawn: (spec) => {
      specs.push(spec)
      return fakeHandle()
    },
    resolveExecutable: async () => '/usr/bin/import',
    config: { display: ':0', jpegQuality: 72 },
  })

  assert.equal(service.status().display, ':0')
  await service.capture()
  // argv = [exe, -display, :0, -window, root, ...]
  assert.equal(specs[0].argv[2], ':0')

  // The browser stack picked :96; the next capture must follow it.
  assert.equal(service.setDisplay(':96'), ':96')
  assert.equal(service.status().display, ':96')
  await service.capture()
  assert.equal(specs[1].argv[2], ':96')
})

test('setDisplay() refuses a value that could read as a flag', () => {
  const service = createCaptureService({
    spawn: () => fakeHandle(),
    resolveExecutable: async () => '/usr/bin/import',
    config: { display: ':0' },
  })

  assert.equal(service.setDisplay('--help'), ':0')
  assert.equal(service.setDisplay('host:1'), ':0')
  assert.equal(service.setDisplay(undefined), ':0')
  assert.equal(service.status().display, ':0')
  // A valid retarget still applies, and stays applied after a rejected one.
  assert.equal(service.setDisplay(':95'), ':95')
  assert.equal(service.setDisplay('nope'), ':95')
})

test('the screenshot tool presents the display cookie it was given', async () => {
  // The nested display runs with access control on, so a capture that does not
  // carry the cookie is refused with "no authorization protocol specified" — the
  // panel sees a 503 and shows nothing, with no hint that a permission was the
  // reason.
  const specs = []
  const service = createCaptureService({
    spawn: (spec) => {
      specs.push(spec)
      return {
        stdout: [],
        stderr: [],
        done: Promise.resolve({ code: 0 }),
        terminate() {},
        waitForExit: () => Promise.resolve(),
      }
    },
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    config: { display: ':200' },
  })
  const removed = service.setAuthority('/tmp/dsh-desktop-vnc-1/Xauthority')
  assert.equal(removed, '/tmp/dsh-desktop-vnc-1/Xauthority', 'the authority is adopted')
  await service.capture().catch(() => undefined)

  const spec = specs.at(-1)
  assert.ok(spec !== undefined, 'a capture was attempted')
  assert.equal(spec.env?.XAUTHORITY, '/tmp/dsh-desktop-vnc-1/Xauthority', 'the cookie travels with the tool')
  assert.equal(spec.env?.DISPLAY, ':200', 'and it draws from the nested display')
})
