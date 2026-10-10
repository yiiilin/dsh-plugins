import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVITY_VERSION, clip, localDate, projectSession } from '../lib/extract.js'

const TZ = 480
/** 2026-09-13 12:00 UTC — inside the CST day 2026-09-13. */
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)

/** Build one `user/message` event. */
const userMessage = (seq, time, kind, text, turn = 1, step = 1) => ({
  type: 'user/message',
  seq,
  time,
  data: { turn, step, role: 'user', content: [{ type: 'text', text }], source: { kind } },
})

const toolCall = (seq, time, name, args, turn = 1, step = 1) => ({
  type: 'tool/call',
  seq,
  time,
  data: { turn, step, callId: `c${seq}`, name, arguments: JSON.stringify(args) },
})

const toolResult = (seq, time, isError, turn = 1, step = 1) => ({
  type: 'tool/result',
  seq,
  time,
  data: { turn, step, message: { role: 'tool', isError, source: { kind: 'tool', callId: `c${seq}` }, content: [] } },
})

test('buckets events into local calendar days at an explicit offset', () => {
  assert.equal(localDate(Date.UTC(2026, 8, 13, 15, 30), TZ), '2026-09-13')
  // 16:00 UTC is already the next day at UTC+8.
  assert.equal(localDate(Date.UTC(2026, 8, 13, 16, 0), TZ), '2026-09-14')
  assert.equal(localDate(Number.NaN, TZ), undefined)
})

test('clip keeps short text and marks a truncation', () => {
  assert.equal(clip('  hello  ', 20), 'hello')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
  assert.equal(clip(undefined, 5), '')
})

test('counts only human prompts on a root session and treats child input as delegation', () => {
  const root = projectSession(
    { id: 's1', createdAt: 1, cwd: '/w/app' },
    [
      userMessage(0, BASE + 1000, 'agent-instructions', 'workspace rules'),
      userMessage(1, BASE + 1100, 'user', 'build the thing'),
      userMessage(2, BASE + 1200, 'plugin', 'runtime context'),
      userMessage(3, BASE + 1300, 'skill-catalog', 'skills'),
      userMessage(4, BASE + 1400, 'agent-message', 'another agent said'),
      userMessage(5, BASE + 1500, 'goal', 'goal round'),
    ],
    { tzOffsetMinutes: TZ },
  )
  assert.equal(root.totals.prompts, 1)
  assert.deepEqual(root.prompts.map((entry) => entry.text), ['build the thing'])

  const child = projectSession(
    { id: 's2', createdAt: 1, cwd: '/w/app', origin: 'subagent', delegationDepth: 1 },
    [userMessage(0, BASE + 1000, 'user', 'you are a delegated worker: do X')],
    { tzOffsetMinutes: TZ },
  )
  // A child's task description is not something the person asked for, and a
  // session with no own tool work produces no activity at all.
  assert.equal(child, undefined)
})

test('strips the parent-agent handshake from a delegated prompt', () => {
  const digest = projectSession(
    { id: 's3', createdAt: 1, cwd: '/w/app', delegationDepth: 1 },
    [
      userMessage(0, BASE + 1000, 'user', 'audit the parser\n\nYour parent agent id is "session-x". Before you finish, send your result.'),
      toolCall(1, BASE + 1100, 'read', { file_path: '/w/app/a.js' }),
    ],
    { tzOffsetMinutes: TZ },
  )
  assert.equal(digest.totals.delegated, 1)
  assert.equal(digest.totals.prompts, 0)
})

test('excludes fork-inherited history from a seeded child', () => {
  const events = [
    { type: 'session/end-seed', seq: 0, time: BASE + 500, data: {} },
    userMessage(1, BASE + 1000, 'user', 'parent prompt'),
    toolCall(2, BASE + 1100, 'edit', { file_path: '/w/app/parent.js' }),
    { type: 'session/end-seed', seq: 3, time: BASE + 2000, data: { inherited: true } },
    userMessage(4, BASE + 3000, 'user', 'child prompt'),
    toolCall(5, BASE + 3100, 'edit', { file_path: '/w/app/child.js' }),
  ]
  const digest = projectSession({ id: 'child', createdAt: 1, cwd: '/w/app', isSeeded: true }, events, { tzOffsetMinutes: TZ })
  assert.equal(digest.totals.toolCalls, 1)
  assert.deepEqual(Object.keys(digest.files), ['/w/app/child.js'])
  assert.equal(digest.firstTime, BASE + 3000)
  // The inherited title is still the best label for the child.
  const withTitle = projectSession(
    { id: 'child', createdAt: 1, cwd: '/w/app', isSeeded: true },
    [{ type: 'session/title', seq: 0, time: BASE + 400, data: { title: 'parent work' } }, ...events],
    { tzOffsetMinutes: TZ },
  )
  assert.equal(withTitle.title, 'parent work')
})

test('honours an explicit inherited cut from the storage handle', () => {
  const events = [
    userMessage(0, BASE + 1000, 'user', 'inherited'),
    toolCall(1, BASE + 1100, 'edit', { file_path: '/w/old.js' }),
    toolCall(2, BASE + 2000, 'edit', { file_path: '/w/new.js' }),
  ]
  const digest = projectSession({ id: 'f', createdAt: 1, cwd: '/w' }, events, { tzOffsetMinutes: TZ, inheritedEventCount: 2 })
  assert.equal(digest.totals.toolCalls, 1)
  assert.deepEqual(Object.keys(digest.files), ['/w/new.js'])
})

test('separates writes from reads and survives unparseable tool arguments', () => {
  const digest = projectSession(
    { id: 's4', createdAt: 1, cwd: '/w/app' },
    [
      userMessage(0, BASE + 1000, 'user', 'work'),
      toolCall(1, BASE + 1100, 'edit', { file_path: '/w/app/a.js' }),
      toolCall(2, BASE + 1200, 'write', { file_path: '/w/app/b.js' }),
      toolCall(3, BASE + 1300, 'read', { file_path: '/w/app/a.js' }),
      toolCall(4, BASE + 1400, 'grep', { pattern: 'needle', path: '/w/app' }),
      toolCall(5, BASE + 1500, 'bash', { command: 'npm test' }),
      { type: 'tool/call', seq: 6, time: BASE + 1600, data: { turn: 1, step: 1, callId: 'c6', name: 'edit', arguments: '{not json' } },
    ],
    { tzOffsetMinutes: TZ },
  )
  assert.deepEqual(Object.keys(digest.files).sort(), ['/w/app/a.js', '/w/app/b.js'])
  assert.equal(digest.totals.toolCalls, 6)
  assert.equal(digest.tools.edit, 2)
  assert.equal(digest.byDay['2026-09-13'].commands[0], 'npm test')
})

test('counts failed tool results and accumulates model usage', () => {
  const digest = projectSession(
    { id: 's5', createdAt: 1, cwd: '/w/app' },
    [
      userMessage(0, BASE + 1000, 'user', 'work'),
      { type: 'step/start', seq: 1, time: BASE + 1100, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 2,
        time: BASE + 1400,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [], usage: { inputTokens: 100, outputTokens: 25 } },
      },
      { type: 'step/end', seq: 3, time: BASE + 1500, data: { turn: 1, step: 1 } },
      toolCall(4, BASE + 1600, 'bash', { command: 'false' }),
      toolResult(4, BASE + 1900, true),
    ],
    { tzOffsetMinutes: TZ },
  )
  assert.equal(digest.totals.inputTokens, 100)
  assert.equal(digest.totals.outputTokens, 25)
  assert.equal(digest.totals.toolErrors, 1)
  assert.equal(digest.totals.llmMs, 300)
  assert.equal(digest.totals.toolMs, 300)
})

test('records a version stamp and drops bookkeeping tools from the breakdown', () => {
  const digest = projectSession(
    { id: 's6', createdAt: 1, cwd: '/w/app' },
    [userMessage(0, BASE + 1000, 'user', 'work'), toolCall(1, BASE + 1100, 'todo_write', { todos: [] }), toolCall(2, BASE + 1200, 'edit', { file_path: '/w/a' })],
    { tzOffsetMinutes: TZ },
  )
  assert.equal(digest.version, ACTIVITY_VERSION)
  assert.equal(digest.tools.todo_write, undefined)
  assert.equal(digest.totals.toolCalls, 2)
})
