import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  createProfileProcesses,
  defaultPortProbe,
  parseLaunchLine,
  readRss,
} from '../lib/profile-process.js'

/** A fake child process with the surface the table touches. */
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter()
  child.stderr.setEncoding = () => {}
  child.killed = []
  child.kill = (signal) => {
    child.killed.push(signal)
    // Real children exit after a signal; model that so `stop` can settle.
    queueMicrotask(() => {
      child.signalCode = signal
      child.emit('exit', null, signal)
    })
    return true
  }
  return child
}

/** A table wired to fakes, with every outside touch injected. */
function harness({
  spawnImpl,
  portRange = [57000, 57002],
  busy = [],
  now = () => 0,
} = {}) {
  const spawned = []
  const children = []
  const logs = []
  const warnings = []
  const table = createProfileProcesses({
    spawn: (spec) => {
      spawned.push(spec)
      const child = spawnImpl === undefined ? fakeChild({ pid: 5000 + spawned.length }) : spawnImpl(spec)
      children.push(child)
      return child
    },
    execPath: '/usr/bin/node',
    script: '/opt/dsh/lib/bin.js',
    dshHome: '/root/.dsh',
    cwd: '/root',
    portRange,
    probe: async (port) => busy.includes(port),
    readFile: async (path) => {
      if (path === '/proc/5001/status') return 'Name:\tnode\nVmRSS:\t  1024 kB\n'
      throw new Error('ENOENT')
    },
    now,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
  })
  return { table, spawned, children, logs, warnings }
}

/** Drive a fake child to the running state. */
function announce(child, { port = 57000, token = 'tok-abc' } = {}) {
  child.stdout.emit('data', `dsh web: http://127.0.0.1:${String(port)}/?token=${token}\n`)
}

/**
 * Wait until the Nth child has actually been spawned, and return that child.
 *
 * `ensure()` claims a port asynchronously before it spawns, so a test that announces
 * a child immediately would race one that does not exist yet.
 *
 * @param {Array<unknown>} children the fakes this harness handed out, in order.
 * @param {number} count which child to wait for (1-based).
 * @returns {Promise<ReturnType<typeof fakeChild>>}
 */
async function untilSpawned(children, count = 1) {
  for (let i = 0; i < 500; i += 1) {
    if (children.length >= count) return children[count - 1]
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`expected ${String(count)} spawned child, saw ${String(children.length)}`)
}

test('parseLaunchLine reads the URL and the token', () => {
  const line = 'dsh web: http://127.0.0.1:57001/?token=Srr4CN5L_WZwdawZ65TXCR4\n'
  assert.deepEqual(parseLaunchLine(line), {
    url: 'http://127.0.0.1:57001/?token=Srr4CN5L_WZwdawZ65TXCR4',
    token: 'Srr4CN5L_WZwdawZ65TXCR4',
  })
})

test('parseLaunchLine is undefined until a full line with a token arrives', () => {
  assert.equal(parseLaunchLine(''), undefined)
  assert.equal(parseLaunchLine('dsh web: http://127.0.0.1:57001/'), undefined, 'a URL with no token is unusable')
  assert.equal(parseLaunchLine('starting up'), undefined)
})

test('ensure spawns with the inherited home, cwd and port', async () => {
  const child = fakeChild()
  const { table, spawned, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  announce(await untilSpawned(children))
  const ready = await pending

  assert.equal(spawned.length, 1)
  const spec = spawned[0]
  assert.equal(spec.command, '/usr/bin/node')
  assert.deepEqual(spec.args, ['/opt/dsh/lib/bin.js', '--profile', 'review', '--no-open', '--port', '57000'])
  assert.equal(spec.env.DSH_HOME, '/root/.dsh', 'the home is inherited, never derived')
  assert.equal(spec.cwd, '/root')
  assert.equal(ready.port, 57000)
  assert.equal(ready.token, 'tok-abc')
})

test('ensure is idempotent while a profile runs', async () => {
  const child = fakeChild()
  const { table, spawned, children } = harness({ spawnImpl: () => child })

  const first = table.ensure('review')
  announce(await untilSpawned(children))
  await first
  await table.ensure('review')
  await table.ensure('review')

  assert.equal(spawned.length, 1, 'one process per profile')
})

test('a second ensure while starting joins the same promise', async () => {
  const child = fakeChild()
  const { table, spawned, children } = harness({ spawnImpl: () => child })

  const a = table.ensure('review')
  const b = table.ensure('review')
  announce(await untilSpawned(children))
  const [first, second] = await Promise.all([a, b])

  assert.equal(spawned.length, 1)
  assert.equal(first.port, second.port)
})

test('a busy port in the pool is skipped, never adopted', async () => {
  const child = fakeChild()
  const { table, spawned, children } = harness({ spawnImpl: () => child, busy: [57000] })

  const pending = table.ensure('review')
  announce(await untilSpawned(children), { port: 57001 })
  const ready = await pending

  assert.equal(ready.port, 57001, 'a foreign listener keeps its port')
  assert.equal(spawned[0].args.at(-1), '57001')
})

test('an exhausted pool reports the range instead of binding something else', async () => {
  const { table } = harness({ busy: [57000, 57001, 57002] })
  await assert.rejects(() => table.ensure('review'), /no free port in localProfilePortRange 57000-57002/)
})

test('a malformed port range fails loudly', () => {
  const { table } = harness({ portRange: [57002, 57000] })
  assert.throws(() => table.bounds(), /localProfilePortRange/)
})

test('a child that exits before its launch line fails the environment', async () => {
  const child = fakeChild()
  const { table, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  ;(await untilSpawned(children)).emit('exit', 1, null)

  await assert.rejects(() => pending, /exited before reporting a launch URL/)
  assert.equal((await table.status('review')).state, 'failed')
})

test('three crashes in a minute mark the environment failed, not restarting', async () => {
  let clock = 0
  const { table, warnings, children } = harness({
    spawnImpl: () => fakeChild(),
    now: () => clock,
  })

  // Boot, then crash three times inside the window.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pending = table.ensure('review')
    announce(await untilSpawned(children, attempt))
    await pending
    clock += 1_000
    children[attempt - 1].emit('exit', 1, null)
    await new Promise((resolve) => setImmediate(resolve))
  }

  const status = await table.status('review')
  assert.equal(status.state, 'failed')
  assert.match(status.error, /exited 3 times within 60s/)
  assert.ok(warnings.some((line) => /failing repeatedly/.test(line)))
})

test('stop signals the child and releases its port', async () => {
  const child = fakeChild()
  const { table, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  announce(await untilSpawned(children))
  await pending

  await table.stop('review')

  assert.deepEqual(child.killed, ['SIGTERM'])
  assert.equal((await table.status('review')).state, 'stopped')
  // The released port is claimable again.
  assert.equal(await table.claimPort(), 57000)
})

test('stop is a no-op for an unknown profile', async () => {
  const { table } = harness()
  await table.stop('nobody')
  assert.equal((await table.status('nobody')).state, 'stopped')
})

test('stopAll stops every child so none outlives the daemon', async () => {
  const { table, children } = harness({ spawnImpl: () => fakeChild() })

  const a = table.ensure('one')
  announce(await untilSpawned(children))
  await a
  const b = table.ensure('two')
  announce(await untilSpawned(children, 2), { port: 57001 })
  await b

  await table.stopAll()
  assert.deepEqual(children.map((child) => child.killed), [['SIGTERM'], ['SIGTERM']])
})

test('status reports the port and pid while running', async () => {
  const child = fakeChild({ pid: 5001 })
  const { table, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  announce(await untilSpawned(children))
  await pending

  const status = await table.status('review', async (path) => {
    if (path === '/proc/5001/status') return 'VmRSS:\t  2048 kB\n'
    throw new Error('ENOENT')
  })
  assert.equal(status.state, 'running')
  assert.equal(status.port, 57000)
  assert.equal(status.pid, 5001)
  assert.equal(status.rssBytes, 2_048 * 1024)
})

test('status omits rss where the platform cannot report it', async () => {
  const child = fakeChild({ pid: 5001 })
  const { table, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  announce(await untilSpawned(children))
  await pending

  const status = await table.status('review', async () => {
    throw new Error('ENOENT')
  })
  assert.equal(status.rssBytes, undefined, 'no fabricated number')
})

test('a failed environment keeps the tail of its stderr', async () => {
  const child = fakeChild()
  const { table, children } = harness({ spawnImpl: () => child })

  const pending = table.ensure('review')
  const booted = await untilSpawned(children)
  booted.stderr.emit('data', 'Error: cannot resolve profile bundle "x"\n')
  booted.emit('exit', 1, null)
  await assert.rejects(() => pending)

  const status = await table.status('review')
  assert.equal(status.state, 'failed')
  assert.match(status.stderrTail, /cannot resolve profile bundle/)
})

test('readRss parses VmRSS and tolerates a missing process', async () => {
  assert.equal(await readRss(1, async () => 'VmRSS:\t  1024 kB\n'), 1024 * 1024)
  assert.equal(await readRss(1, async () => 'Name:\tnode\n'), undefined)
  assert.equal(
    await readRss(1, async () => {
      throw new Error('ENOENT')
    }),
    undefined,
  )
})

test('the default probe reports a closed port as free', async () => {
  // Port 1 is never a listener on a test host; the probe must answer, not hang.
  assert.equal(await defaultPortProbe(1, 200), false)
})
