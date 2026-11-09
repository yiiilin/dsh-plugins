/**
 * This node's own identity.
 *
 * A federation is a set of ids. Every node needs one of the same kind, or a table of them
 * is a table of things nobody can compare — which is what happened when the main node
 * answered with its listen address and an edge read that row without recognising the node
 * it was connected to.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureNodeId } from '../lib/node-id.js'
import { ID_PATTERN } from '../lib/registry.js'

/** A throwaway daemon directory. */
async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'node-id-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('an id is created once and kept', async (t) => {
  const dir = await scratch(t)
  const first = await ensureNodeId({ daemonDir: dir })
  const second = await ensureNodeId({ daemonDir: dir })
  assert.equal(first, second, 'a restart must not rename the node')
  assert.match(first, ID_PATTERN)
})

test('the id reaches disk so it survives the process', async (t) => {
  const dir = await scratch(t)
  const id = await ensureNodeId({ daemonDir: dir })
  assert.equal((await readFile(join(dir, 'node-id'), 'utf8')).trim(), id)
})

test('a configured id wins over the stored one', async (t) => {
  const dir = await scratch(t)
  await ensureNodeId({ daemonDir: dir })
  assert.equal(await ensureNodeId({ daemonDir: dir, configured: 'my-node' }), 'my-node')
})

test('a corrupt file is replaced rather than trusted', async (t) => {
  // A malformed id would put a bad route prefix on every URL this node advertises.
  const dir = await scratch(t)
  await writeFile(join(dir, 'node-id'), 'Not An Id!\n')
  const id = await ensureNodeId({ daemonDir: dir })
  assert.match(id, ID_PATTERN)
  assert.notEqual(id, 'Not An Id!')
})

test('a node with nowhere to write reports no id rather than a shared one', async () => {
  // An id every node answers to would make two machines indistinguishable; empty is the
  // honest answer, and callers already treat it as "not known yet".
  assert.equal(await ensureNodeId({ daemonDir: '' }), '')
})

test('two profiles sharing one home keep separate ids', async (t) => {
  // Every profile on a machine reads the same daemon directory. One file for all of them
  // introduced two processes to the federation under a single id, so routes to either
  // landed on whichever answered first.
  const dir = await scratch(t)
  const a = await ensureNodeId({ daemonDir: dir, profile: 'main' })
  const b = await ensureNodeId({ daemonDir: dir, profile: 'edge' })
  assert.notEqual(a, b)
  assert.equal(await ensureNodeId({ daemonDir: dir, profile: 'main' }), a)
  assert.equal(await ensureNodeId({ daemonDir: dir, profile: 'edge' }), b)
})
