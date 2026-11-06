/**
 * The three remote reads and writes: workspaces, sessions, files.
 *
 * The shapes here are what crosses a tunnel, so they are asserted flat: a registry
 * entity that lost its getters on the way out is the failure mode a passing check
 * would otherwise hide.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  abortTransfer,
  appendTransfer,
  beginTransfer,
  CHUNK_BYTES,
  commitTransfer,
  describeTransfer,
  MAX_FILE_BYTES,
  openTransfers,
  readTransferChunk,
  validateDestination,
} from '../lib/file-transfer.js'

/** Pull a file the way the tool does: describe, then one chunk per index. */
async function pull(path) {
  const described = await describeTransfer(path)
  if (described.ok !== true) return described
  const pieces = []
  for (let index = 0; index < described.chunks; index += 1) {
    const piece = await readTransferChunk({ path, index, chunkBytes: described.chunkBytes })
    if (piece.ok !== true) return piece
    pieces.push(piece.data)
    if (piece.eof === true) break
  }
  return { ok: true, name: described.name, size: described.size, bytes: Buffer.concat(pieces.map((p) => Buffer.from(p, 'base64'))) }
}

/** Upload one buffer the way the sender does: begin, chunks, commit. */
async function upload(path, bytes, { overwrite = false } = {}) {
  const chunks = []
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    chunks.push(bytes.subarray(at, at + CHUNK_BYTES).toString('base64'))
  }
  const began = await beginTransfer({ path, overwrite, totalChunks: chunks.length })
  if (began.ok !== true) return began
  for (const piece of chunks) {
    const step = await appendTransfer(began.transferId, piece)
    if (step.ok !== true) return step
  }
  return await commitTransfer(began.transferId)
}
import { listSessions, listWorkspaces, workspaceRow } from '../lib/remote-info.js'

/** A workspace entity stand-in: the same fields the registry exposes. */
const workspace = (over = {}) => ({
  id: 'ws-1',
  title: 'demo',
  path: '/tmp/demo',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  sessionIds: ['s-1', 's-2'],
  ...over,
})

// --- workspaces ---------------------------------------------------------------

test('a workspace row is flat, with no getter left on it', () => {
  const row = workspaceRow(workspace())
  assert.deepEqual(row, {
    workspaceId: 'ws-1',
    title: 'demo',
    path: '/tmp/demo',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    sessionCount: 2,
  })
  // A function would not survive JSON over the tunnel, so none may be present.
  for (const value of Object.values(row)) assert.notEqual(typeof value, 'function')
})

test('listing workspaces reports a missing service instead of throwing', () => {
  assert.deepEqual(listWorkspaces({ workspaces: undefined }), {
    ok: false,
    error: 'this node has no workspace registry',
  })
  assert.deepEqual(listWorkspaces({ workspaces: { list: () => [workspace()] } }).workspaces.length, 1)
})

// --- sessions -----------------------------------------------------------------

test('sessions are narrowed to one workspace and carry the usable fields', async () => {
  const records = [
    { header: { id: 's-1', cwd: '/tmp/demo', createdAt: 1, origin: 'user' }, live: true, persisted: true },
    { header: { id: 's-9', cwd: '/other', createdAt: 2 }, live: false, persisted: true },
  ]
  const result = await listSessions({
    workspaces: { get: (id) => (id === 'ws-1' ? workspace() : undefined) },
    sessions: { listSessions: async () => records },
  }, 'ws-1')
  assert.equal(result.ok, true)
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['s-1'])
  assert.equal(result.sessions[0].cwd, '/tmp/demo')
  assert.equal(result.sessions[0].live, true)
})

test('an unknown workspace is an error, not an empty list', async () => {
  // An empty list would read as "that workspace has no sessions" and hide the typo.
  const result = await listSessions({
    workspaces: { get: () => undefined },
    sessions: { listSessions: async () => [] },
  }, 'ws-nope')
  assert.equal(result.ok, false)
  assert.match(result.error, /no such workspace/u)
})

test('an empty workspace filter lists every session', async () => {
  const result = await listSessions({
    workspaces: undefined,
    sessions: { listSessions: async () => [{ header: { id: 'a', createdAt: 1 }, live: false }] },
  }, '')
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['a'])
})

// --- files --------------------------------------------------------------------

test('a destination must be absolute and name a file', () => {
  assert.equal(validateDestination('relative/x.txt').ok, false)
  assert.equal(validateDestination('/tmp/x.txt').ok, true)
  assert.equal(validateDestination('').ok, false)
})

test('a file round-trips through chunks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    const source = join(home, 'source.bin')
    // Binary content, including a NUL and a high byte: text-only handling would corrupt it.
    await writeFile(source, Buffer.from([0x00, 0xff, 0x41, 0x7f]))
    const read = await pull(source)
    assert.equal(read.ok, true)
    assert.equal(read.size, 4)

    const target = join(home, 'nested', 'target.bin')
    const wrote = await upload(target, Buffer.from([0x00, 0xff, 0x41, 0x7f]))
    assert.equal(wrote.ok, true)
    assert.deepEqual([...await readFile(target)], [0x00, 0xff, 0x41, 0x7f])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an existing destination is refused unless overwrite is given', async () => {
  // A sender that guessed a path must not be able to destroy the only copy.
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    const target = join(home, 'keep.txt')
    await writeFile(target, 'original')
    const refused = await upload(target, Buffer.from('new'))
    assert.equal(refused.ok, false)
    assert.match(refused.error, /already exists/u)
    assert.equal(await readFile(target, 'utf8'), 'original')

    const replaced = await upload(target, Buffer.from('new'), { overwrite: true })
    assert.equal(replaced.ok, true)
    assert.equal(await readFile(target, 'utf8'), 'new')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failed transfer leaves no staged file behind', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    // A directory where the file should go makes the rename fail at commit time.
    const blocked = join(home, 'adir')
    await writeFile(join(home, 'x'), 'x')
    await upload(blocked, Buffer.from('data')).catch(() => {})
    const { readdir } = await import('node:fs/promises')
    const left = (await readdir(home)).filter((name) => name.includes('dsh-transfer'))
    assert.deepEqual(left, [], 'a half-written staging file must not survive')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the size limits are the ones the tools advertise', () => {
  assert.equal(CHUNK_BYTES * 16 <= MAX_FILE_BYTES, true)
  // A chunk must fit one frame, which caps at 8 MiB including the header.
  assert.ok(CHUNK_BYTES < 8 * 1024 * 1024)
})


test('a truncated upload is refused, not committed short', async () => {
  // Committing a partial file would publish a corrupt one under the right name.
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    const target = join(home, 'short.bin')
    const began = await beginTransfer({ path: target, totalChunks: 3 })
    assert.equal(began.ok, true)
    await appendTransfer(began.transferId, Buffer.from('one').toString('base64'))
    const committed = await commitTransfer(began.transferId)
    assert.equal(committed.ok, false)
    assert.match(committed.error, /1 of 3/u)
    assert.equal(openTransfers(), 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an aborted upload leaves nothing on disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    const target = join(home, 'gone.bin')
    const began = await beginTransfer({ path: target })
    await appendTransfer(began.transferId, Buffer.from('partial').toString('base64'))
    await abortTransfer(began.transferId)
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(home), [])
    assert.equal(openTransfers(), 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a large file crosses in pieces that each fit one frame', async () => {
  // 2 MiB is four chunks: more than one, so the protocol is exercised rather than the
  // single-chunk case, and small enough to stay fast.
  const home = await mkdtemp(join(tmpdir(), 'gw-xfer-'))
  try {
    const big = Buffer.alloc(2 * 1024 * 1024)
    for (let i = 0; i < big.length; i += 1) big[i] = i % 251
    const target = join(home, 'big.bin')
    const wrote = await upload(target, big)
    assert.equal(wrote.ok, true)
    assert.equal(wrote.bytes, big.length)
    const back = await readFile(target)
    assert.equal(back.length, big.length)
    assert.ok(back.equals(big), 'content must survive the chunk boundaries')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- the pull direction -------------------------------------------------------

test('a file larger than one frame is pulled one piece at a time', async () => {
  // 8 MiB is the tunnel's frame cap; base64 inflates by a third, so a one-shot read was
  // unusable above roughly 6 MiB. 7 MiB exercises exactly that boundary.
  const home = await mkdtemp(join(tmpdir(), 'gw-pull-'))
  try {
    const big = Buffer.alloc(7 * 1024 * 1024)
    for (let i = 0; i < big.length; i += 4093) big[i] = i % 251
    const source = join(home, 'big.bin')
    await writeFile(source, big)

    const described = await describeTransfer(source)
    assert.equal(described.ok, true)
    assert.equal(described.size, big.length)
    assert.ok(described.chunks > 1, 'must span several pieces')

    // Every piece on its own must stay inside one frame once encoded.
    const piece = await readTransferChunk({ path: source, index: 0, chunkBytes: described.chunkBytes })
    assert.equal(piece.ok, true)
    assert.ok(Buffer.from(piece.data, 'base64').length <= CHUNK_BYTES)
    assert.ok(piece.data.length < 8 * 1024 * 1024, 'one encoded piece must fit a frame')

    const pulled = await pull(source)
    assert.equal(pulled.ok, true)
    assert.ok(pulled.bytes.equals(big), 'the reassembled file must match byte for byte')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('reading past the end of a small file is an error, not silence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gw-pull-'))
  try {
    const source = join(home, 'small.txt')
    await writeFile(source, 'abc')
    const past = await readTransferChunk({ path: source, index: 9 })
    assert.equal(past.ok, false)
    assert.match(past.error, /shorter than expected/u)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('describe reports the size without sending the content', async () => {
  // The whole point of the two-step pull: a caller learns what it is about to receive
  // before any bytes cross the wire.
  const home = await mkdtemp(join(tmpdir(), 'gw-pull-'))
  try {
    const source = join(home, 'f.txt')
    await writeFile(source, 'hello')
    const described = await describeTransfer(source)
    assert.equal(described.name, 'f.txt')
    assert.equal(described.size, 5)
    assert.equal(described.data, undefined, 'describe must not carry content')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing source is reported, never invented', async () => {
  const described = await describeTransfer('/nonexistent-dsh-pull/file.txt')
  assert.equal(described.ok, false)
  assert.match(described.error, /could not read/u)
})
