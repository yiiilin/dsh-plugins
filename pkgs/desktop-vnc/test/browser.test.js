/**
 * Unit tests for the Xephyr + Chromium browser stack: display auto-pick,
 * argv/env shape, single-start reuse, concurrent ensure sharing, pid-scoped
 * teardown and the Xephyr→Xvfb fail-soft fallback.
 *
 * Nothing here starts a real process, touches the real `/tmp` display files or
 * signals a real pid: `spawn`, `resolveExecutable`, `probe`, `kill` and
 * `removeDir` are all injected.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_START_URL,
  DEFAULT_WINDOW_TITLE,
  NESTED_DISPLAY_MAX,
  NESTED_DISPLAY_MIN,
  XEPHYR_EXECUTABLE,
  XVFB_EXECUTABLE,
  chromiumArgv,
  createBrowserStack,
  describeFallback,
  describeSpawnError,
  displayNumber,
  lockPathFor,
  parseDisplay,
  pickFreeDisplay,
  socketPathFor,
  writeXauthority,
  xephyrArgv,
  xvfbArgv,
} from '../browser.js'

// --- fixtures ---------------------------------------------------------------

/** A released-on-demand child handle with the subprocess handle's surface. */
function fakeHandle({ pid = 4242, stubborn = false } = {}) {
  const handle = {
    pid,
    terminated: 0,
    exitCode: null,
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
    // A "stubborn" child ignores the provider's polite terminate, which is what
    // forces the SIGKILL rung of the ladder.
    if (!stubborn) handle.resolve(0)
  }
  handle.waitForExit = () => Promise.resolve(true)
  handle.collected = {
    stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    stderr: { readFrom: () => ({ text: handle.stderrText, nextOffset: 0, lossy: false }) },
  }
  return handle
}

/** Base name of an argv[0], to tell the servers from the browser. */
function commandName(argv) {
  return String(argv[0]).split('/').pop()
}

/**
 * A display probe whose "present" set the test drives. Every probed display is
 * recorded so tests can assert the pick never touched an occupied number.
 */
function displayProbe(initial = []) {
  const present = new Set(initial)
  const probed = []
  const probe = async (display) => {
    probed.push(display)
    return present.has(display)
  }
  return { probe, present, probed }
}

/**
 * Record every spawn spec. `onSpawn` runs before the handle is returned, which
 * lets a test publish the nested display socket exactly when the server starts.
 */
function recordingSpawn({ handles = [], onSpawn } = {}) {
  const specs = []
  const spawn = (spec) => {
    const index = specs.length
    specs.push(spec)
    onSpawn?.(spec, index)
    return handles[index] ?? fakeHandle({ pid: 5000 + index })
  }
  return { spawn, specs }
}

/** Spawn hook that makes a server's display appear ready the moment it starts. */
function publishDisplayWhenServerStarts(present) {
  return (spec) => {
    const name = commandName(spec.argv)
    if (name === XEPHYR_EXECUTABLE || name === XVFB_EXECUTABLE) present.add(spec.argv[1])
  }
}

/** Every pid, in order, that a stack signalled. */
function killedPids(kills) {
  return kills.map((call) => call.pid)
}

/** A recording replacemen for `process.kill`; never signals a real process. */
function recordingKill() {
  const calls = []
  const kill = (pid, signal) => {
    calls.push({ pid, signal })
  }
  return { kill, calls }
}

/** A recording directory remover; never touches the real filesystem. */
function recordingRemoveDir() {
  const calls = []
  const removeDir = async (dir) => {
    calls.push(dir)
  }
  return { removeDir, calls }
}

/** A stack wired to entirely fake infrastructure, with fast timings. */
function makeStack({
  config = {},
  handles = [],
  probe,
  resolveExecutable,
  onSpawn,
  kill = recordingKill(),
  removeDir = recordingRemoveDir(),
  tmpDir = '/tmp/dsh-test',
  pid = 777,
} = {}) {
  const spawn = recordingSpawn({ handles, onSpawn })
  const stack = createBrowserStack({
    spawn: spawn.spawn,
    resolveExecutable,
    config: { viewportWidth: 1280, viewportHeight: 800, ...config },
    probe,
    kill: kill.kill,
    removeDir: removeDir.removeDir,
    tmpDir,
    pid,
    startTimeoutMs: 30,
    probeIntervalMs: 1,
    settleMs: 1,
    graceMs: 5,
  })
  return { stack, specs: spawn.specs, kill, removeDir, tmpDir, pid }
}

/** The happy-path wiring: Xephyr then Chromium, both alive. */
function happyStack(extra = {}) {
  const displays = displayProbe()
  const { stack, specs, kill, removeDir } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
    ...extra,
  })
  return { stack, specs, kill, removeDir, displays }
}

// --- pure helpers -----------------------------------------------------------

test('parseDisplay accepts the spellings a config or CLI can carry', () => {
  assert.equal(parseDisplay(':96'), ':96')
  assert.equal(parseDisplay('96'), ':96')
  assert.equal(parseDisplay(':96.0'), ':96')
  assert.equal(parseDisplay('  :90 '), ':90')
  assert.equal(parseDisplay(':0'), ':0')
  // Anything that is not a display must not reach an argv.
  assert.equal(parseDisplay(''), null)
  assert.equal(parseDisplay('localhost:10.0'), null)
  assert.equal(parseDisplay('$DISPLAY'), null)
  assert.equal(parseDisplay('--screen'), null)
  assert.equal(parseDisplay(undefined), null)
})

test('lock and socket paths follow the X11 convention', () => {
  assert.equal(displayNumber(':96'), 96)
  assert.equal(lockPathFor(':96'), '/tmp/.X96-lock')
  assert.equal(socketPathFor(':96'), '/tmp/.X11-unix/X96')
  assert.equal(lockPathFor('nonsense'), null)
  assert.equal(socketPathFor('nonsense'), null)
})

test('pickFreeDisplay takes the first number with no lock and no socket', async () => {
  const first = NESTED_DISPLAY_MIN
  const occupied = new Set([`:${first}`, `:${first + 1}`])
  const { probe, probed } = displayProbe(occupied)
  assert.equal(await pickFreeDisplay({ probe }), `:${first + 2}`)
  // It stops at the first free number instead of scanning the whole range.
  assert.deepEqual(probed, [`:${first}`, `:${first + 1}`, `:${first + 2}`])
})

test('the nested display range stays clear of where test tooling starts X servers', () => {
  // `:90` and its neighbours are what headless harnesses conventionally claim. A
  // panel that took the first free number there shared a display with whatever
  // else on the machine wanted one.
  assert.ok(
    NESTED_DISPLAY_MIN > 120,
    `the range must start above the conventional test band, got ${NESTED_DISPLAY_MIN}`,
  )
})

test('pickFreeDisplay reports a full range instead of a doomed display', async () => {
  const every = []
  for (let number = NESTED_DISPLAY_MIN; number <= NESTED_DISPLAY_MAX; number += 1) {
    every.push(`:${number}`)
  }
  const { probe } = displayProbe(every)
  assert.equal(await pickFreeDisplay({ probe }), null)
})

test('pickFreeDisplay honours an explicit range and survives a throwing probe', async () => {
  assert.equal(await pickFreeDisplay({ probe: async () => false, min: 300, max: 302 }), ':300')

  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls === 1) throw new Error('EACCES: /tmp/.X11-unix')
    return false
  }
  // An unreadable probe is not proof of occupancy: the start attempt reports the
  // real failure rather than this one hiding it.
  assert.equal(await pickFreeDisplay({ probe: flaky }), `:${NESTED_DISPLAY_MIN}`)
})

test('xephyrArgv is the frozen, desktop-visible server invocation', () => {
  const argv = xephyrArgv('/usr/bin/Xephyr', {
    display: ':96',
    width: 1280,
    height: 800,
    title: 'DSH Desktop Browser',
    authFile: '/tmp/dsh-desktop-vnc-1/Xauthority',
  })
  assert.deepEqual(argv, [
    '/usr/bin/Xephyr',
    ':96',
    '-screen', '1280x800x24',
    '-auth', '/tmp/dsh-desktop-vnc-1/Xauthority',
    '-br',
    '-noreset',
    '-title', 'DSH Desktop Browser',
    '-resizeable',
  ])
  // Access control stays on. The display is a general-purpose one that other
  // tools on this machine also use, so `-ac` let any local process draw onto the
  // view the panel mirrors.
  assert.equal(argv.includes('-ac'), false, 'access control must not be disabled')
})

test('xvfbArgv is the headless fallback, with no title and no tcp listener', () => {
  const argv = xvfbArgv('/usr/bin/Xvfb', {
    display: ':96',
    width: 1024,
    height: 768,
    authFile: '/tmp/dsh-desktop-vnc-1/Xauthority',
  })
  assert.deepEqual(argv, [
    '/usr/bin/Xvfb',
    ':96',
    '-screen', '1024x768x24',
    '-auth', '/tmp/dsh-desktop-vnc-1/Xauthority',
    '-br',
    '-noreset',
    '-nolisten', 'tcp',
  ])
  assert.equal(argv.includes('-ac'), false, 'access control must not be disabled')
  // The fallback must never claim to be the visible server.
  assert.equal(argv.includes('-title'), false)
  assert.equal(argv.includes('-resizeable'), false)
})

test('chromiumArgv carries every flag the frozen contract requires', () => {
  const argv = chromiumArgv('/usr/bin/chromium', {
    userDataDir: '/tmp/dsh-desktop-vnc-777/profile',
    width: 1280,
    height: 800,
    startUrl: 'https://example.test/',
  })
  assert.deepEqual(argv, [
    '/usr/bin/chromium',
    '--no-sandbox',
    // Suppresses the "--no-sandbox is unsupported" infobar in the mirrored pane.
    '--test-type',
    '--user-data-dir=/tmp/dsh-desktop-vnc-777/profile',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-crash-restore-bubble',
    '--window-position=0,0',
    '--window-size=1280,800',
    'https://example.test/',
  ])
})

test('chromiumArgv appends extraArgs before the URL and defaults the URL', () => {
  const argv = chromiumArgv('/usr/bin/chromium', {
    userDataDir: '/tmp/x/profile',
    width: 640,
    height: 480,
    extraArgs: ['--lang=zh-CN'],
    startUrl: '',
  })
  assert.equal(argv[argv.length - 1], DEFAULT_START_URL)
  assert.equal(argv[argv.length - 2], '--lang=zh-CN')
})

test('spawn failures become one readable line', () => {
  const missing = new Error('subprocess-local: command "Xephyr" was not found on PATH')
  missing.code = 'ENOENT'
  assert.equal(describeSpawnError(missing, 'Xephyr'), 'Xephyr 未安装（Xephyr not installed）')

  const denied = new Error('EACCES: permission denied')
  assert.match(describeSpawnError(denied, 'Xephyr'), /不可执行/)
  assert.equal(describeSpawnError(new Error('boom\nstack line'), 'Xephyr'), 'boom')
  assert.equal(describeSpawnError(undefined, 'Xephyr'), '无法启动 Xephyr')
})

test('the fallback wording stays honest about desktop visibility', () => {
  assert.match(describeFallback('Xephyr 未安装（Xephyr not installed）'), /桌面不可见/)
})

// --- happy path -------------------------------------------------------------

test('ensure() starts Xephyr with DISPLAY set, then chromium in the nested display', async () => {
  const { stack, specs } = happyStack()
  const result = await stack.ensure()

  assert.equal(result.ok, true)
  assert.equal(result.browser, true)
  assert.equal(result.chromium, true)
  assert.equal(result.xephyr, true)
  assert.equal(result.desktopVisible, true)
  assert.equal(result.mode, 'xephyr')
  assert.equal(result.display, `:${NESTED_DISPLAY_MIN}`)
  assert.deepEqual(result.started, { xephyr: true, chromium: true })

  assert.equal(specs.length, 2)

  // ① Xephyr, and the load-bearing DISPLAY=<host desktop> that makes its window
  // land on :0 instead of failing with "cannot open host display".
  const server = specs[0]
  assert.equal(commandName(server.argv), XEPHYR_EXECUTABLE)
  assert.equal(server.argv[1], `:${NESTED_DISPLAY_MIN}`)
  assert.deepEqual(server.argv.slice(2), [
    '-screen', '1280x800x24',
    '-auth', join('/tmp/dsh-test', 'dsh-desktop-vnc-777', 'Xauthority'),
    '-br', '-noreset',
    '-title', DEFAULT_WINDOW_TITLE,
    '-resizeable',
  ])
  assert.equal(server.env.DISPLAY, ':0')

  // ② Chromium, rendering inside the nested display, not the host one.
  const browser = specs[1]
  assert.equal(commandName(browser.argv), 'chromium')
  assert.equal(browser.env.DISPLAY, `:${NESTED_DISPLAY_MIN}`)
  // The browser presents the same cookie the server was told to trust.
  assert.equal(browser.env.XAUTHORITY, join('/tmp/dsh-test', 'dsh-desktop-vnc-777', 'Xauthority'))
  assert.ok(browser.argv.includes('--no-sandbox'))
  assert.ok(browser.argv.includes(`--user-data-dir=${join('/tmp/dsh-test', 'dsh-desktop-vnc-777', 'profile')}`))
  assert.ok(browser.argv.includes('--window-size=1280,800'))
  assert.equal(browser.argv[browser.argv.length - 1], DEFAULT_START_URL)

  // Collect stdio: an inherited stream would pollute the host's own logs.
  for (const spec of specs) {
    assert.equal(spec.stdio.stdin, 'ignore')
    assert.notEqual(spec.stdio.stdout, 'inherit')
    assert.notEqual(spec.stdio.stderr, 'inherit')
    assert.equal(typeof spec.stdio.stdout.maxBytes, 'number')
    assert.equal(spec.graceMs, 5)
  }
})

test('status() before any ensure() reports nothing running and the host display', () => {
  const { stack } = happyStack()
  const status = stack.status()
  assert.equal(status.display, ':0')
  assert.equal(status.running, false)
  assert.equal(status.xephyr, false)
  assert.equal(status.chromium, false)
  assert.equal(status.desktopVisible, false)
  assert.equal(status.mode, 'none')
  assert.deepEqual(status.pids, {})
})

test('status() reports the owned pids once the stack is up', async () => {
  const displays = displayProbe()
  const { stack } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
    handles: [fakeHandle({ pid: 111 }), fakeHandle({ pid: 222 })],
  })

  await stack.ensure()
  const status = stack.status()
  assert.equal(status.running, true)
  assert.equal(status.display, `:${NESTED_DISPLAY_MIN}`)
  assert.equal(status.xephyr, true)
  assert.equal(status.chromium, true)
  assert.equal(status.desktopVisible, true)
  assert.deepEqual(status.pids, { xephyr: 111, chromium: 222 })
})

test('an explicit nestedDisplay is used verbatim instead of auto-picking', async () => {
  const displays = displayProbe()
  const { stack, specs } = makeStack({
    config: { browser: { nestedDisplay: ':101' } },
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
  })

  const result = await stack.ensure()
  assert.equal(result.display, ':101')
  assert.equal(specs[0].argv[1], ':101')
  assert.equal(specs[1].env.DISPLAY, ':101')
  // No candidate scanning happened: the only display probed is the explicit one,
  // and only to confirm it came up.
  assert.equal(displays.probed.every((display) => display === ':101'), true)
  assert.deepEqual([...new Set(displays.probed)], [':101'])
})

test('auto-pick skips occupied nested displays', async () => {
  const first = NESTED_DISPLAY_MIN
  const displays = displayProbe([`:${first}`, `:${first + 1}`, `:${first + 2}`])
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
  })

  const result = await stack.ensure()
  assert.equal(result.display, `:${first + 3}`)
  assert.equal(specs[0].argv[1], `:${first + 3}`)
  assert.equal(specs[1].env.DISPLAY, `:${first + 3}`)
})

test('a full nested range fails with a readable reason and starts nothing', async () => {
  const every = []
  for (let number = NESTED_DISPLAY_MIN; number <= NESTED_DISPLAY_MAX; number += 1) {
    every.push(`:${number}`)
  }
  const { stack, specs } = makeStack({
    probe: displayProbe(every).probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
  })

  const result = await stack.ensure()
  assert.equal(result.ok, false)
  assert.equal(result.browser, false)
  assert.match(result.error, /没有空闲的嵌套显示号/)
  assert.equal(specs.length, 0)
})

// --- reuse and concurrency --------------------------------------------------

test('a second ensure() reuses the live stack instead of spawning again', async () => {
  const { stack, specs } = happyStack()

  await stack.ensure()
  assert.equal(specs.length, 2)

  const second = await stack.ensure()
  assert.equal(specs.length, 2, 'a live display and browser must be reused')
  assert.equal(second.ok, true)
  assert.deepEqual(second.started, { xephyr: false, chromium: false })
})

test('concurrent ensure() calls start exactly one Xephyr and one chromium', async () => {
  const displays = displayProbe()
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
  })

  const results = await Promise.all([
    stack.ensure(), stack.ensure(), stack.ensure(), stack.ensure(),
  ])

  assert.equal(specs.length, 2, 'four racing callers share one start')
  for (const result of results) {
    assert.equal(result.ok, true)
    assert.equal(result.display, `:${NESTED_DISPLAY_MIN}`)
  }
})

test('a crashed chromium is re-started without respawning the Xephyr it runs in', async () => {
  const displays = displayProbe()
  const dead = fakeHandle({ pid: 10 })
  const live = fakeHandle({ pid: 11 })
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: (spec, index) => {
      publishDisplayWhenServerStarts(displays.present)(spec)
      // The first chromium (index 1) dies inside its settle window; the second
      // (index 2) survives, which is what "re-start the browser" means.
      if (index === 1) dead.resolve(1)
    },
    handles: [fakeHandle({ pid: 9 }), dead, live],
  })

  // The first chromium dies during its settle window.
  const first = await stack.ensure()
  assert.equal(first.ok, false)
  assert.equal(first.chromium, false)
  assert.match(first.error, /chromium exited with code 1/)
  assert.equal(first.xephyr, true, 'the nested server survived the browser crash')

  dead.resolve(1)
  await new Promise((resolve) => setImmediate(resolve))

  const second = await stack.ensure()
  assert.equal(second.ok, true)
  assert.equal(second.chromium, true)
  // Only a second chromium: the Xephyr on :90 is still reused.
  assert.equal(specs.filter((spec) => commandName(spec.argv) === XEPHYR_EXECUTABLE).length, 1)
  assert.equal(specs.filter((spec) => commandName(spec.argv) === 'chromium').length, 2)
})

// --- teardown ---------------------------------------------------------------

test('stop() signals only the pids it started and removes only its own profile', async () => {
  const displays = displayProbe()
  const xephyr = fakeHandle({ pid: 111 })
  const chromium = fakeHandle({ pid: 222 })
  const { stack, kill, removeDir } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
    handles: [xephyr, chromium],
  })

  await stack.ensure()
  await stack.stop()

  // Exactly our two pids, never a name and never a foreign pid.
  assert.deepEqual(new Set(killedPids(kill.calls)), new Set([111, 222]))
  for (const call of kill.calls) {
    assert.ok(call.signal === 'SIGTERM' || call.signal === 'SIGKILL')
  }
  // Both polite TERMs were enough: the fake children exited on terminate().
  assert.equal(kill.calls.filter((call) => call.signal === 'SIGKILL').length, 0)
  assert.equal(xephyr.terminated, 1)
  assert.equal(chromium.terminated, 1)

  // The per-instance user-data-dir is ours to delete.
  assert.deepEqual(removeDir.calls, [join('/tmp/dsh-test', 'dsh-desktop-vnc-777', 'profile')])
  assert.equal(stack.status().running, false)
  assert.deepEqual(stack.status().pids, {})
})

test('a child that ignores SIGTERM is escalated to SIGKILL after the grace period', async () => {
  const displays = displayProbe()
  const xephyr = fakeHandle({ pid: 333 })
  const chromium = fakeHandle({ pid: 444, stubborn: true })
  const { stack, kill } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: publishDisplayWhenServerStarts(displays.present),
    handles: [xephyr, chromium],
  })

  await stack.ensure()
  await stack.stop()

  const toChromium = kill.calls.filter((call) => call.pid === 444)
  assert.deepEqual(toChromium.map((call) => call.signal), ['SIGTERM', 'SIGKILL'])
  // The responsive server was stopped at the first rung: no collateral KILLs.
  assert.deepEqual(kill.calls.filter((call) => call.pid === 333).map((call) => call.signal), ['SIGTERM'])
})

test('stopping an untouched stack signals nothing and removes nothing', async () => {
  const { stack, kill, removeDir } = happyStack()
  await stack.stop()
  assert.deepEqual(kill.calls, [])
  assert.deepEqual(removeDir.calls, [])
})

test('dispose() tears the stack down and refuses further ensures', async () => {
  const { stack, kill } = happyStack()
  await stack.ensure()
  await stack.dispose()

  assert.equal(kill.calls.length >= 1, true)
  assert.equal(stack.status().running, false)
  await assert.rejects(() => stack.ensure(), /disposed/)
})

// --- Xephyr → Xvfb fail-soft fallback ---------------------------------------

test('a missing Xephyr falls back to Xvfb and reports the desktop as invisible', async () => {
  const displays = displayProbe()
  const chromium = fakeHandle({ pid: 222 })
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => {
      if (command === XEPHYR_EXECUTABLE) {
        const error = new Error(`subprocess-local: command "${XEPHYR_EXECUTABLE}" was not found on PATH`)
        error.code = 'ENOENT'
        throw error
      }
      return `/usr/bin/${command}`
    },
    onSpawn: publishDisplayWhenServerStarts(displays.present),
    handles: [fakeHandle({ pid: 111 }), chromium],
  })

  const result = await stack.ensure()

  // The panel is usable, so the stack is a success...
  assert.equal(result.ok, true)
  assert.equal(result.browser, true)
  assert.equal(result.chromium, true)
  // ...but it is degraded, honestly: no Xephyr, nothing on the desktop.
  assert.equal(result.xephyr, false)
  assert.equal(result.desktopVisible, false)
  assert.equal(result.mode, 'xvfb')
  assert.equal(result.degraded, true)
  assert.equal(result.fallback, XVFB_EXECUTABLE)
  assert.equal(result.display, `:${NESTED_DISPLAY_MIN}`)
  assert.deepEqual(result.started, { xephyr: false, chromium: true })
  // The Xephyr reason travels in `error` even though the start succeeded.
  assert.match(result.error, /Xephyr 未安装/)
  assert.equal(result.warning, result.error)

  assert.equal(specs.length, 2)
  assert.equal(commandName(specs[0].argv), XVFB_EXECUTABLE)
  assert.equal(specs[0].env, undefined, 'the headless fallback needs no host display')
  assert.equal(specs[1].env.DISPLAY, `:${NESTED_DISPLAY_MIN}`)

  const status = stack.status()
  assert.equal(status.running, true)
  assert.equal(status.xephyr, false)
  assert.equal(status.chromium, true)
  assert.equal(status.desktopVisible, false)
  assert.equal(status.mode, 'xvfb')
  assert.equal(status.degraded, true)
  assert.deepEqual(status.pids, { xvfb: 111, chromium: 222 })
})

test('an Xephyr that never publishes its display falls back to Xvfb', async () => {
  // The probe only turns true once the *fallback* server has started, so the
  // Xephyr start times out and the fallback is what rescues the panel.
  let ready = false
  const probe = async () => ready
  const { stack, specs } = makeStack({
    probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: (spec) => {
      if (commandName(spec.argv) === XVFB_EXECUTABLE) ready = true
    },
  })

  const result = await stack.ensure()
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'xvfb')
  assert.equal(result.desktopVisible, false)
  assert.match(result.error, /Xephyr/)
  assert.equal(commandName(specs[0].argv), XEPHYR_EXECUTABLE)
  assert.equal(commandName(specs[1].argv), XVFB_EXECUTABLE)
})

test('an Xephyr spawn that throws EACCES also degrades to Xvfb', async () => {
  const displays = displayProbe()
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    onSpawn: (spec) => {
      if (commandName(spec.argv) === XEPHYR_EXECUTABLE) {
        const error = new Error('EACCES: permission denied')
        error.code = 'EACCES'
        throw error
      }
      publishDisplayWhenServerStarts(displays.present)(spec)
    },
  })

  const result = await stack.ensure()
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'xvfb')
  assert.match(result.error, /Xephyr 不可执行/)
  assert.equal(commandName(specs[1].argv), XVFB_EXECUTABLE)
})

test('both servers missing fails with both readable reasons and spawns no chromium', async () => {
  const displays = displayProbe()
  const { stack, specs } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => {
      const error = new Error(`subprocess-local: command "${command}" was not found on PATH`)
      error.code = 'ENOENT'
      throw error
    },
  })

  const result = await stack.ensure()
  assert.equal(result.ok, false)
  assert.equal(result.browser, false)
  assert.equal(result.display, `:${NESTED_DISPLAY_MIN}`)
  assert.match(result.error, /Xephyr 未安装/)
  assert.match(result.error, /Xvfb 未安装/)
  assert.equal(specs.length, 0)
})

test('a missing chromium is reported without killing the server it would render in', async () => {
  const displays = displayProbe()
  const { stack, kill } = makeStack({
    probe: displays.probe,
    resolveExecutable: async (command) => {
      if (command === 'chromium') {
        const error = new Error('subprocess-local: command "chromium" was not found on PATH')
        error.code = 'ENOENT'
        throw error
      }
      return `/usr/bin/${command}`
    },
    onSpawn: publishDisplayWhenServerStarts(displays.present),
  })

  const result = await stack.ensure()
  assert.equal(result.ok, false)
  assert.equal(result.browser, false)
  assert.match(result.error, /chromium 未安装/)
  // Xephyr is alive and must be left for a later retry.
  assert.equal(result.xephyr, true)
  assert.equal(kill.calls.length, 0)
})

// --- disabled ---------------------------------------------------------------

test('browser.enabled=false starts nothing and reports the host display', async () => {
  const displays = displayProbe()
  const { stack, specs } = makeStack({
    config: { browser: { enabled: false } },
    probe: displays.probe,
    resolveExecutable: async (command) => `/usr/bin/${command}`,
  })

  const result = await stack.ensure()
  assert.equal(result.ok, true)
  assert.equal(result.browser, false)
  assert.equal(result.xephyr, false)
  assert.equal(result.desktopVisible, false)
  assert.equal(result.mode, 'disabled')
  assert.equal(result.display, ':0')
  assert.equal(specs.length, 0)

  const status = stack.status()
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.equal(status.display, ':0')
})

test('the Xauthority it writes is one xauth itself would have written', async () => {
  // The format is unforgiving and silent when wrong: a cookie written with the
  // wrong family byte or an empty address is still a valid file, it just never
  // matches, and the symptom is every client being refused with no hint why.
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-xauth-'))
  const path = join(directory, 'Xauthority')
  const cookie = Buffer.alloc(16, 0x5a)
  try {
    writeXauthority(path, '211', cookie)
    const record = await readFile(path)

    // Family is `FamilyLocal`, and it is the one field stored little-endian.
    assert.deepEqual([...record.subarray(0, 2)], [0x01, 0x00], 'family is FamilyLocal, little-endian')
    // The address is the host name, never empty: a blank address matches no host.
    const addressLength = record.readUInt16BE(2)
    assert.ok(addressLength > 0, 'the address is not empty')
    const address = record.subarray(4, 4 + addressLength).toString('latin1')
    assert.equal(address, (await import('node:os')).hostname(), 'the address is this host')

    // Then the display number, the cookie name, and the cookie — all big-endian.
    let at = 4 + addressLength
    const numberLength = record.readUInt16BE(at)
    at += 2
    assert.equal(record.subarray(at, at + numberLength).toString('latin1'), '211', 'the display number')
    at += numberLength
    const nameLength = record.readUInt16BE(at)
    at += 2
    assert.equal(record.subarray(at, at + nameLength).toString('latin1'), 'MIT-MAGIC-COOKIE-1', 'the cookie name')
    at += nameLength
    const cookieLength = record.readUInt16BE(at)
    at += 2
    assert.deepEqual([...record.subarray(at, at + cookieLength)], [...cookie], 'the cookie itself')

    // Owner-only: the cookie is a credential, not a hint.
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'the file is readable only by its owner')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
