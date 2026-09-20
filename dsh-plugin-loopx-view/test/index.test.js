import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildViewProjection,
  decodeRequest,
  projectGraph,
  sanitizeText,
} from '../index.js'

test('sanitizeText removes credentials and local paths', () => {
  const value = sanitizeText('token=abc123 /root/private/project/file.txt')
  assert.equal(value, 'token=[redacted] [path]')
})

test('decodeRequest accepts only the exact session read request', () => {
  assert.deepEqual(
    decodeRequest({ v: 'loopx_view_request_v1', op: 'read', sessionId: 'session-1' }),
    { v: 'loopx_view_request_v1', op: 'read', sessionId: 'session-1' },
  )
  assert.equal(decodeRequest({ v: 'loopx_view_request_v1', op: 'read', sessionId: 'a/b' }), undefined)
  assert.equal(decodeRequest({ v: 'loopx_view_request_v1', op: 'read', sessionId: 'session-1', extra: true }), undefined)
})

test('projectGraph keeps bounded public-safe nodes and edges', () => {
  const graph = projectGraph({
    schema_version: 'task_graph_projection_v0',
    nodes: [{ node_id: 'todo-1', kind: 'deliverable', title: 'Ship feature', state: 'blocked', owner_agent: 'agent-1' }],
    edges: [{ from_node_id: 'todo-1', to_node_id: 'lease-1', relation: 'depends_on', reason: '/root/private' }],
  })
  assert.deepEqual(graph.nodes[0], {
    nodeId: 'todo-1', kind: 'deliverable', title: 'Ship feature', state: 'blocked', ownerAgent: 'agent-1',
  })
  assert.equal(graph.edges[0].reason, '[path]')
})

test('buildViewProjection scopes status to the exact bound Goal', () => {
  const payload = {
    attention_queue: {
      items: [{
        goal_id: 'goal-1',
        status: 'implementation_authorized_handoff',
        waiting_on: 'agent',
        recommended_action: 'Run the next task',
        project_asset: {
          gate: 'none',
          agent_todos: { open: 2, done: 3, total: 5 },
          task_graph_projection: {
            schema_version: 'task_graph_projection_v0',
            nodes: [],
            edges: [],
          },
        },
      }],
    },
  }
  const result = buildViewProjection(payload, { goalId: 'goal-1', loopxAgentId: 'agent-1' }, 'session-1', 'idle')
  assert.equal(result.goalId, 'goal-1')
  assert.equal(result.loopxAgentId, 'agent-1')
  assert.deepEqual(result.progress, { open: 2, done: 3, total: 5 })
  assert.equal(result.nextAction, 'Run the next task')
})
