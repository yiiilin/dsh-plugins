/**
 * Unit tests for the x11vnc lifecycle: port reuse, single-spawn concurrency,
 * argv shape, failure reporting and teardown. Nothing here starts a real
 * process; `spawn`, `resolveExecutable` and the port probe are all injected.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import {
  createX11VncController,
  describeSpawnError,
  normalizeDisplay,
  normalizePort,
  x11vncArgv,
} from '../x11vnc.js'

/** A released-on-demand child handle with the subprocess handle's surface. */
function fakeHandle({ pid = 4242 } = {}) {
  const handle = {
    pid,
    terminated: 0,
    waited: 0,
    exitCode: null,
    stdoutText: '',
    stderrText: '',
    resolved: false,
    resolve: null,
  }
  handle.done = new Promise((resolve) => {
    handle.resolve = (exitCode = 0) => {
      if (handle.resolved) return
      handle.resolved = true
      handle.exitCode = exitCode
      resolve({ exitCode, signal: null })
    }
  })
  handle.terminate = () => {
    handle.terminated += 1
    handle.resolve(0)
  }
  handle.waitForExit = () => {
    handle.waited += 1
    return Promise.resolve(true)
  }
  handle.collected = {
    stdout: { readFrom: () => ({ text: handle.stdoutText, nextOffset: 0, lossy: false }) },
    stderr: { readFrom: () => ({ text: handle.stderrText, nextOffset: 0, lossy: false }) },
  }
  return handle
}

/** A probe whose listening state the test drives explicitly. */
function controllableProbe(initial = false) {
  const state = { listening: initial, calls: 0 }
  const probe = async () => {
    state.calls += 1
    return state.listening
  }
  return { probe, state }
}

/**
 * A probe replaying a scripted sequence of listening states; the last value
 * repeats once the script is exhausted.
 */
function scriptedProbe(sequence) {
  const state = { calls: 0 }
  const probe = async () => {
    const index = Math.min(state.calls, sequence.length - 1)
    state.calls += 1
    return sequence[index]
  }
  return { probe, state }
}

/** Collect the spawn specs a controller received. */
function recordingSpawn(handles = [], onSpawn) {
  const specs = []
  const spawn = (spec) => {
    specs.push(spec)
    onSpawn?.(spec, specs.length - 1)
    const handle = handles[specs.length - 1] ?? fakeHandle()
    handles.push(handle)
    return handle
  }
  return { spawn, specs, handles }
}

/** The `-rfbport` value in a recorded spawn spec. */
function spawnedPort(spec) {
  return Number(spec.argv[spec.argv.indexOf('-rfbport') + 1])
}

/**
 * A port probe whose listening set the test drives. Every probed port is
 * recorded, so a test can assert which ports the allocator considered.
 */
function portProbe(initial = []) {
  const listening = new Set(initial)
  const probed = []
  const probe = async (port) => {
    probed.push(port)
    return listening.has(port)
  }
  return { probe, listening, probed }
}

/** Spawn hook that publishes a controller's port the moment its child starts. */
function publishPortWhenServerStarts(listening) {
  return (spec) => {
    listening.add(spawnedPort(spec))
  }
}

test('an externally occupied port is skipped, never connected to', async () => {
  // "Somebody is listening" must never mean "that is my VNC server": adopting a
  // foreign one makes the second panel silently show the first one's desktop.
  const { probe, listening } = portProbe([5900])
  const { spawn, specs } = recordingSpawn([fakeHandle()], publishPortWhenServerStarts(listening))
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  const result = await vnc.ensure()
  assert.deepEqual(result, { running: true, port: 5901, started: true })
  assert.equal(specs.length, 1)
  assert.equal(spawnedPort(specs[0]), 5901, 'the foreign 5900 was never spawned against')
  // The port is the one this controller bound, not the configured preference.
  assert.equal(vnc.status().port, 5901)
  assert.equal(vnc.status().running, true)
})

test('two controllers in one process take two different ports', async () => {
  const { probe, listening } = portProbe()
  const make = () => {
    const { spawn, specs } = recordingSpawn([fakeHandle()], publishPortWhenServerStarts(listening))
    const vnc = createX11VncController({
      spawn,
      resolveExecutable: async () => '/usr/bin/x11vnc',
      config: { display: ':0', rfbPort: 5900 },
      probe,
      probeIntervalMs: 1,
    })
    return { vnc, specs }
  }
  const first = make()
  const second = make()

  const a = await first.vnc.ensure()
  const b = await second.vnc.ensure()

  assert.equal(a.port, 5900)
  assert.equal(b.port, 5901)
  assert.notEqual(a.port, b.port)
  assert.equal(first.specs.length, 1)
  assert.equal(second.specs.length, 1)
  assert.equal(spawnedPort(second.specs[0]), 5901)
})

test('the port comes from the configured range, low to high', async () => {
  const { probe, listening } = portProbe([6000, 6001])
  const { spawn, specs } = recordingSpawn([fakeHandle()], publishPortWhenServerStarts(listening))
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [6000, 6004] },
    probe,
    probeIntervalMs: 1,
  })

  const result = await vnc.ensure()
  assert.equal(result.port, 6002)
  assert.equal(spawnedPort(specs[0]), 6002)
})

test('the exhaustion error names the configured range, not a candidate-derived one', async () => {
  // A v1 single port *inside* the pool is tried first, so the candidate list no
  // longer starts at the range's low end. An operator reading the error needs the
  // range they configured, not the reordered candidate window.
  const { probe } = portProbe([6000, 6001, 6002, 6003, 6004])
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [6000, 6004], rfbPort: 6002 },
    probe,
  })

  const result = await vnc.ensure()
  assert.equal(result.running, false)
  assert.match(result.error, /6000\.\.:6004/)
  assert.equal(specs.length, 0)
})

test('an exhausted port range fails with a readable error and starts nothing', async () => {
  const { probe } = portProbe([5900, 5901])
  const { spawn, specs } = recordingSpawn()
  const logs = []
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [5900, 5901] },
    probe,
    probeIntervalMs: 1,
    log: (level, message) => logs.push([level, message]),
  })

  const result = await vnc.ensure()
  assert.equal(result.running, false)
  assert.equal(result.started, false)
  // The failure names the range, so an operator knows what to widen.
  assert.match(result.error, /5900/)
  assert.match(result.error, /5901/)
  assert.match(result.error, /端口/)
  // Never a silent reuse and never a doomed spawn.
  assert.equal(specs.length, 0)
  assert.equal(vnc.status().running, false)
  assert.equal(logs.some(([level]) => level === 'warn'), true)
})

test('an ensure() after its own start reuses that server instead of respawning', async () => {
  const { probe, listening } = portProbe()
  const { spawn, specs } = recordingSpawn([fakeHandle()], publishPortWhenServerStarts(listening))
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  const first = await vnc.ensure()
  const second = await vnc.ensure()

  assert.deepEqual(first, { running: true, port: 5900, started: true })
  assert.deepEqual(second, { running: true, port: 5900, started: false })
  assert.equal(specs.length, 1, 'the server this controller started is reused')
})

test('an externally occupied port is reused by nobody, even after a retarget', async () => {
  // Everything in range belongs to somebody else: the controller reports that
  // instead of adopting a server it did not start.
  const { probe } = portProbe([5900, 5901, 5902])
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [5900, 5902] },
    probe,
  })

  await vnc.ensure()
  vnc.setDisplay(':96')
  await vnc.stop()

  assert.equal(specs.length, 0)
  assert.equal(vnc.display(), ':96')
  assert.equal(vnc.status().running, false)
})

test('the frozen argv exposes only the local TCP port of the display', () => {
  const argv = x11vncArgv('/usr/bin/x11vnc', { display: ':0', port: 5900 })
  assert.equal(argv[0], '/usr/bin/x11vnc')
  assert.deepEqual(argv.slice(1), [
    '-display', ':0',
    '-rfbport', '5900',
    '-localhost',
    '-nopw',
    '-forever',
    '-shared',
    '-quiet',
    '-noxdamage',
    '-repeat',
    '-nowf',
  ])
})

test('a listening port is never adopted: it is skipped, not reused', async () => {
  // The pre-v2 contract reused whatever answered the port. That made a second
  // panel silently show the first instance's desktop, so adoption is gone: a
  // listening port is somebody else's server and is passed over.
  const { probe, state } = controllableProbe(true)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [5900, 5900] },
    probe,
  })

  const result = await vnc.ensure()
  assert.equal(result.running, false)
  assert.equal(result.started, false)
  assert.match(result.error, /5900/)
  // Nothing was adopted and nothing was spawned against a foreign server.
  assert.equal(specs.length, 0)
  assert.ok(state.calls >= 1)
  // status() never reports somebody else's server as ours.
  assert.equal(vnc.status().running, false)
})

test('the port is spawned against and polled until it answers', async () => {
  // First probe is the reuse check (miss), every later one is the bind wait (hit).
  const { probe } = scriptedProbe([false, true])
  const { spawn, specs } = recordingSpawn([fakeHandle()])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':1', rfbPort: 5901 },
    probe,
    probeIntervalMs: 1,
  })

  const result = await vnc.ensure()
  assert.deepEqual(result, { running: true, port: 5901, started: true })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].argv[2], ':1')
  assert.equal(specs[0].argv[4], '5901')
  // The child must not inherit the host's stdio.
  assert.equal(specs[0].stdio.stdin, 'ignore')
  assert.notEqual(specs[0].stdio.stdout, 'inherit')
  assert.notEqual(specs[0].stdio.stderr, 'inherit')
  assert.equal(specs[0].graceMs, 2000)
  assert.equal(vnc.status().running, true)
  assert.equal(vnc.status().pid, 4242)
})

test('concurrent ensure() calls start exactly one process', async () => {
  const { probe, state } = controllableProbe(false)
  const { spawn, specs } = recordingSpawn([fakeHandle()])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  // Four callers race while the spawn is still pending.
  const pending = Promise.all([vnc.ensure(), vnc.ensure(), vnc.ensure(), vnc.ensure()])
  state.listening = true
  const results = await pending

  assert.equal(specs.length, 1, 'only one x11vnc may be spawned')
  for (const result of results) assert.equal(result.running, true)
})

test('a later ensure() may spawn again after the first child exited', async () => {
  // Each ensure() is reuse-miss then bind-hit; the middle miss is the second start.
  const { probe } = scriptedProbe([false, true, false, true])
  const first = fakeHandle({ pid: 1 })
  const second = fakeHandle({ pid: 2 })
  const { spawn, specs } = recordingSpawn([first, second])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  await vnc.ensure()
  assert.equal(specs.length, 1)

  // The child dies and the port stops answering.
  first.resolve(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(vnc.status().running, false)

  await vnc.ensure()
  assert.equal(specs.length, 2)
})

test('stop() terminates and waits for exactly the process it started', async () => {
  const { probe } = scriptedProbe([false, true])
  const handle = fakeHandle()
  const { spawn } = recordingSpawn([handle])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  await vnc.ensure()
  await vnc.stop()

  assert.equal(handle.terminated, 1)
  assert.equal(handle.waited, 1)
  assert.equal(vnc.status().running, false)
  // A second stop has nothing of ours left to touch.
  await vnc.stop()
  assert.equal(handle.terminated, 1)
})

test('a controller that adopted nothing has nothing to stop', async () => {
  const { probe } = controllableProbe(true)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPortRange: [5900, 5900] },
    probe,
  })

  await vnc.ensure()
  await vnc.stop()
  // Nothing was spawned, so nothing may be terminated.
  assert.equal(specs.length, 0)
  assert.deepEqual(vnc.status(), { running: false, port: 5900 })
})

test('a missing x11vnc yields a readable error instead of throwing', async () => {
  const { probe } = controllableProbe(false)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => {
      const error = new Error('subprocess-local: command "x11vnc" was not found on PATH')
      error.code = 'ENOENT'
      throw error
    },
    config: { display: ':0', rfbPort: 5900 },
    probe,
  })

  const result = await vnc.ensure()
  assert.equal(result.running, false)
  assert.equal(result.started, false)
  assert.match(result.error, /未安装|not installed/)
  assert.equal(specs.length, 0)
})

test('a child that never binds is terminated and reported', async () => {
  const { probe } = controllableProbe(false)
  const handle = fakeHandle()
  const { spawn } = recordingSpawn([handle])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
    startTimeoutMs: 30,
  })

  const result = await vnc.ensure()
  assert.equal(result.running, false)
  assert.match(result.error, /did not bind|未/)
  // A failed start must not leave a stray process holding the port.
  assert.equal(handle.terminated, 1)
})

test('a spawn that dies early reports why rather than timing out', async () => {
  const { probe } = controllableProbe(false)
  const handle = fakeHandle()
  handle.stderrText = 'could not connect to display :0\n'
  const logs = []
  const { spawn } = recordingSpawn([handle])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
    startTimeoutMs: 200,
    log: (level, message) => logs.push([level, message]),
  })

  const pending = vnc.ensure()
  handle.resolve(1)
  const result = await pending
  assert.equal(result.running, false)
  assert.match(result.error, /exited with code 1/)
})

test('a disabled configuration refuses to start anything', async () => {
  const { probe } = controllableProbe(false)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { enabled: false, display: ':0', rfbPort: 5900 },
    probe,
  })

  await assert.rejects(() => vnc.ensure(), /disabled/)
  assert.equal(specs.length, 0)
})

test('dispose() stops the owned child, and further ensures are refused', async () => {
  const { probe } = scriptedProbe([false, true])
  const handle = fakeHandle()
  const { spawn } = recordingSpawn([handle])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  await vnc.ensure()
  await vnc.dispose()
  assert.equal(handle.terminated, 1)
  await assert.rejects(() => vnc.ensure(), /disposed/)
})

test('an invalid port falls back to 5900 rather than reaching argv', () => {
  assert.equal(normalizePort(5900), 5900)
  assert.equal(normalizePort('5901'), 5901)
  assert.equal(normalizePort(0), 5900)
  assert.equal(normalizePort(-1), 5900)
  assert.equal(normalizePort(70000), 5900)
  assert.equal(normalizePort('abc'), 5900)
  assert.equal(normalizePort(undefined), 5900)
})

test('spawn failures become one readable line', () => {
  const missing = new Error('subprocess-local: command "x11vnc" was not found on PATH')
  missing.code = 'ENOENT'
  assert.equal(describeSpawnError(missing, 'x11vnc'), 'x11vnc 未安装（x11vnc not installed）')

  const denied = new Error('EACCES: permission denied')
  assert.match(describeSpawnError(denied, 'x11vnc'), /不可执行/)
  assert.equal(describeSpawnError(new Error('boom\nstack line'), 'x11vnc'), 'boom')
  assert.equal(describeSpawnError(undefined, 'x11vnc'), '无法启动 x11vnc')
})

test('probePort reports a real listener and a dead port correctly', async () => {
  const { createServer } = await import('node:net')
  const { probePort } = await import('../x11vnc.js')
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  assert.equal(await probePort(port), true)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await probePort(port, { timeoutMs: 200 }), false)
})

// --- v2: the mirrored display is retargeted to the nested one ----------------

test('normalizeDisplay accepts only a local display and never a flag', () => {
  assert.equal(normalizeDisplay(':0'), ':0')
  assert.equal(normalizeDisplay(':96'), ':96')
  assert.equal(normalizeDisplay(' :10 '), ':10')
  assert.equal(normalizeDisplay(':0.1'), ':0.1')
  assert.equal(normalizeDisplay('--help'), ':0')
  assert.equal(normalizeDisplay('host:1'), ':0')
  assert.equal(normalizeDisplay(''), ':0')
  assert.equal(normalizeDisplay(undefined), ':0')
  assert.equal(normalizeDisplay(undefined, ':7'), ':7')
})

test('setDisplay() retargets the next spawn at the nested display', async () => {
  const { probe } = scriptedProbe([false, true])
  const { spawn, specs } = recordingSpawn([fakeHandle()])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  // v2: the controller is built before the nested display is known.
  assert.equal(vnc.display(), ':0')
  assert.equal(vnc.setDisplay(':96'), ':96')

  const result = await vnc.ensure()
  assert.equal(result.running, true)
  assert.equal(specs.length, 1)
  // argv = [exe, -display, :96, -rfbport, 5900, ...]
  assert.equal(specs[0].argv[0], '/usr/bin/x11vnc')
  assert.equal(specs[0].argv[1], '-display')
  assert.equal(specs[0].argv[2], ':96')
  assert.equal(vnc.display(), ':96')
})

test('setDisplay() refuses nonsense and keeps the previous display', () => {
  const vnc = createX11VncController({
    spawn: () => fakeHandle(),
    config: { display: ':0', rfbPort: 5900 },
    probe: async () => false,
  })

  assert.equal(vnc.setDisplay('--evil'), ':0')
  assert.equal(vnc.setDisplay(undefined), ':0')
  assert.equal(vnc.setDisplay(':95'), ':95')
  // An unusable retarget must not silently reset to the host display.
  assert.equal(vnc.setDisplay('nope'), ':95')
})

test('retargeting an owned x11vnc retires it so the next ensure() respawns', async () => {
  // reuse-miss/bind-hit for the first start; then the retarget; then a fresh start.
  const { probe } = scriptedProbe([false, true, false, true])
  const first = fakeHandle({ pid: 1 })
  const second = fakeHandle({ pid: 2 })
  const { spawn, specs } = recordingSpawn([first, second])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  await vnc.ensure()
  assert.equal(specs.length, 1)
  assert.equal(vnc.status().running, true)

  // The browser stack settles on :96: a child mirroring :0 no longer matches.
  vnc.setDisplay(':96')
  assert.equal(vnc.display(), ':96')
  assert.equal(first.terminated, 1, 'the stale child must be stopped')
  assert.equal(vnc.status().running, false)

  await vnc.ensure()
  assert.equal(specs.length, 2)
  assert.equal(specs[1].argv[2], ':96')
})

test('retargeting never touches a server this controller did not start', async () => {
  // A pre-existing x11vnc keeps answering the port: it is reused and never killed.
  const { probe } = controllableProbe(true)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
  })

  await vnc.ensure()
  vnc.setDisplay(':96')
  await vnc.stop()

  assert.equal(specs.length, 0)
  assert.equal(vnc.display(), ':96')
})

test('an unchanged retarget is a no-op for the owned child', async () => {
  const { probe } = scriptedProbe([false, true])
  const handle = fakeHandle()
  const { spawn } = recordingSpawn([handle])
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':96', rfbPort: 5900 },
    probe,
    probeIntervalMs: 1,
  })

  await vnc.ensure()
  vnc.setDisplay(':96')
  assert.equal(handle.terminated, 0)
  assert.equal(vnc.status().running, true)
})

test('the RFB server presents the display cookie it was given', async () => {
  // Access control is on for the nested display. A server that does not carry the
  // cookie exits with "Authorization required", and the panel's websocket is
  // answered with a 503 — a failure that looks like the server missing entirely.
  const { probe } = controllableProbe(false)
  const { spawn, specs } = recordingSpawn()
  const vnc = createX11VncController({
    spawn,
    resolveExecutable: async () => '/usr/bin/x11vnc',
    config: { display: ':0', rfbPort: 5900 },
    probe,
  })

  vnc.setAuthority('/tmp/dsh-desktop-vnc-1/Xauthority')
  await vnc.ensure()

  const spec = specs.at(-1)
  assert.ok(spec !== undefined, 'the server was started')
  assert.equal(spec.env?.XAUTHORITY, '/tmp/dsh-desktop-vnc-1/Xauthority', 'the cookie travels with the server')
  assert.equal(spec.env?.DISPLAY, ':0', 'and it mirrors the display it was told to')
})
