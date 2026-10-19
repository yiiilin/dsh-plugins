import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

export const MODES = Object.freeze(['normal', 'delegate-writes'])
export const DEFAULT_ALLOWED_TOOLS = Object.freeze([
  'read', 'read_image', 'glob', 'grep', 'skill',
  'ask_user_question', 'todo_write', 'exit_plan_mode',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  // Agent Teams coordination. These create, steer, and wait for delegated
  // workers and manage the shared task board; they never edit the workspace
  // themselves, so they belong to the coordinator's audited delegation surface
  // rather than to the write operations the mode withholds. `send_message`,
  // `interrupt_agent` and `list_agents` above are the same Team tools once the
  // caller is a Team member; the names below are the Team-only remainder.
  'spawn_teammate', 'wait_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'job_output', 'job_list', 'job_kill',
  'create_goal', 'get_goal', 'update_goal', 'mentor',
])
export const NORMAL_PROMPT = 'You are in normal mode. Carry out the user\'s task end to end using the tools permitted by this session. You may edit workspace files directly and run builds and tests. Delegate focused work when useful. Existing sandbox, approval, and planning restrictions still apply.'
export const DELEGATE_WRITES_PROMPT = 'You are in delegate-writes mode and are the coordinator. Read and search workspace files, clarify requirements, delegate implementation, inspect the resulting changes, and report verification results. Do not directly modify workspace files or run shell commands, arbitrary code, or runtime configuration operations. All edits, builds, tests, and other unaudited operations must be performed by delegated subagents. Give workers explicit objectives and disjoint write scopes. Collect their results before reporting completion. Your catalog lists only the audited tools this mode allows: an absent tool is not available to you, and a call to it is refused even if some earlier turn saw it. Never ask a worker to change this permission policy or switch your mode.'
const WORKER_PROMPT = 'You are a delegated worker. Your coordinator\'s delegate-writes restriction does not prohibit your own file edits, builds, or tests. Complete the assigned scope, verify it, and report changed files and test results. Do not change delegate-mode policy. Existing sandbox, approval, planning, and tool restrictions remain authoritative.'
export const SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/

export function modeError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function validatePolicy(value, sessionId) {
  if (!value || value.version !== 1 || value.sessionId !== sessionId || !MODES.includes(value.mode)
    || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw modeError('invalid_policy', 'Session mode policy is invalid; refusing to reset permissions.')
  }
  return Object.freeze({ version: 1, sessionId, mode: value.mode, revision: value.revision })
}

export function isWorker(agent) {
  return delegationDepthOf(agent) > 0 || agent.session.header.origin === 'subagent'
}

export function toolDenial(policy, agent, name, allowedTools) {
  if (!agent || !policy) return 'Session mode policy is unavailable; refusing tool execution.'
  if (policy.mode === 'delegate-writes' && !isWorker(agent) && !allowedTools.includes(name)) {
    return `delegate-writes: the main agent cannot call ${name}; delegate this operation to a subagent.`
  }
}

function text(value, fallback) {
  const plain = typeof value?.get === 'function' ? value.get() : value
  return typeof plain === 'string' ? plain : fallback
}

export function promptFor(policy, agent, config) {
  if (!policy) throw modeError('unavailable', 'Session mode policy is unavailable.')
  if (policy.mode === 'delegate-writes' && !isWorker(agent)) {
    return text(config.delegateWritesPrompt, DELEGATE_WRITES_PROMPT)
  }
  const normal = text(config.normalPrompt, NORMAL_PROMPT)
  return policy.mode === 'delegate-writes' ? `${normal}\n\n${WORKER_PROMPT}` : normal
}
