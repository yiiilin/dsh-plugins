/**
 * The agent-message tools.
 *
 * Two tools, and the split is deliberate: a model that cannot list the environments
 * cannot address them, and a tool whose `envId` it has to guess would fail in a way the
 * model cannot learn from.
 *
 * - `agent_list_envs` reports the environments this node can reach and whether each is
 *   online right now.
 * - `agent_send` delivers one message into a session on one of them.
 *
 * **The message arrives as a user message.** `sessionController.prompt` hardcodes
 * `{ kind: 'user' }`, so the receiving session cannot be told "this came from another
 * agent" through the envelope. The body carries a `[agent-message] from=… session=…`
 * prefix instead, composed by the receiving node — never by the sender, which could
 * otherwise claim to be any environment.
 *
 * @module @yiln-dsh/dsh-gateway/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { MAX_MESSAGE_CHARS, validateMessageRequest } from './lib/agent-message.js'

/** Render one value as the single JSON text block the model reads. */
const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

const LIST_DESCRIPTION = [
  'List the other DSH environments this gateway can reach, with whether each is online right now.',
  'Call this before agent_send when you do not already know the envId: the id is not the label,',
  'and a message addressed to the wrong id fails. The local node appears as envId "self".',
].join(' ')

const SEND_DESCRIPTION = [
  'Deliver a message into a session on another DSH environment (or this one), addressed by',
  'envId + sessionId. The session id is the UUID shown in the session list; a session that is',
  'not running is woken by the delivery. This returns as soon as the message is accepted into',
  'that session inbox — it does not wait for the agent there to answer.',
  'The receiving session sees a user message prefixed "[agent-message] from=<envId> session=<sender>"',
  'so a human can tell it apart from something they typed.',
].join(' ')

/**
 * The `agent_list_envs` row shape.
 *
 * `online` is the only volatile field, and it is the one that matters: a send to an
 * offline environment fails, so the model has to be able to see it first.
 */
const ENV_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // This value-schema DSL puts `required` on the property, not in a `required` array.
  properties: {
    envId: { type: 'string', required: true, description: 'Pass this as agent_send envId. "self" is this node.' },
    label: { type: 'string', required: true },
    online: { type: 'boolean', required: true },
  },
}

/**
 * Build the tool definitions.
 *
 * The two operations are passed in rather than imported so the caller decides where
 * they land: the same tools drive a main node (which routes to its edges) and an edge
 * (which can only reach itself and the main node).
 *
 * @param options.listEnvironments - `() => { envId, label, online }[]`.
 * @param options.send - `(message) => Promise<{ ok, accepted?, error? }>`.
 * @returns the tool definitions.
 */
const WORKSPACES_DESCRIPTION = [
  'List the workspaces of a DSH environment, with each workspace id, title, absolute path',
  'and how many sessions it holds. Use it to learn a workspaceId for agent_sessions, or to',
  'see where another machine keeps its work. Read-only.',
].join(' ')

const SESSIONS_DESCRIPTION = [
  'List the sessions inside one workspace of a DSH environment (or across all of them when',
  'workspaceId is omitted). Each row carries the session id to pass to agent_send, its cwd,',
  'creation time, parent, and whether it is live and persisted on that node. Read-only.',
].join(' ')

const GET_FILE_DESCRIPTION = [
  'Pull one file from another DSH environment (or from this one) into this machine.',
  'Give the absolute source path and, to keep it, a local toPath — it is written here,',
  'staged and renamed so a partial transfer never appears as a file; an existing local',
  'file is refused unless overwrite is true. Omit toPath to receive the content here in',
  'memory instead of writing it. Nothing is ever written on the source machine. Limit 32 MiB.',
].join(' ')

/**
 * Build the tool definitions.
 *
 * @param options.listEnvironments - `() => { envId, label, online }[]`.
 * @param options.send - `(message) => Promise<{ ok, accepted?, error? }>`.
 * @param options.listWorkspaces - `(envId) => Promise<{ ok, workspaces?, error? }>`.
 * @param options.listSessions - `(envId, workspaceId) => Promise<{ ok, sessions?, error? }>`.
 * @param options.getFile - `(request) => Promise<{ ok, name?, size?, path?, chunks?, error? }>`.
 * @returns the tool definitions.
 */
export function agentMessageTools({ listEnvironments, send, listWorkspaces, listSessions, getFile }) {
  return [
    defineTool({
      name: 'agent_list_envs',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: {
        schema: { type: 'array', items: ENV_SCHEMA },
        render: jsonRender,
      },
      async execute() {
        return listEnvironments()
      },
    }),
    defineTool({
      name: 'agent_send',
      description: SEND_DESCRIPTION,
      parameters: {
        sessionId: {
          type: 'string',
          description: 'Target session UUID (the id in the session list, without a "session-" prefix needed).',
          required: true,
        },
        text: {
          type: 'string',
          description: `Message body. At most ${MAX_MESSAGE_CHARS} characters.`,
          required: true,
        },
        envId: {
          type: 'string',
          description: 'Target environment id from agent_list_envs. Omit to deliver to this node.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            accepted: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        const checked = validateMessageRequest(args)
        if (checked.ok !== true) return { ok: false, accepted: false, error: checked.error }
        // The sender's own session is what the receiver will see in the prefix. It is
        // read from the execution, not from the arguments: a model that could name its
        // own session could claim a message came from somewhere else.
        const fromSessionId = exec?.agent?.id ?? ''
        return await send({
          envId: checked.value.envId,
          sessionId: checked.value.sessionId,
          text: checked.value.text,
          fromSessionId,
        })
      },
    }),
    defineTool({
      name: 'agent_workspaces',
      description: WORKSPACES_DESCRIPTION,
      parameters: {
        envId: {
          type: 'string',
          description: 'Environment to ask, from agent_list_envs. Omit to read this node.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            workspaces: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'string' },
          },
        },
        render: jsonRender,
      },
      async execute(args) {
        return await listWorkspaces(String(args?.envId ?? '').trim())
      },
    }),
    defineTool({
      name: 'agent_sessions',
      description: SESSIONS_DESCRIPTION,
      parameters: {
        workspaceId: {
          type: 'string',
          description: 'Workspace id from agent_workspaces. Omit to list sessions across every workspace.',
        },
        envId: {
          type: 'string',
          description: 'Environment to ask, from agent_list_envs. Omit to read this node.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'string' },
          },
        },
        render: jsonRender,
      },
      async execute(args) {
        return await listSessions(
          String(args?.envId ?? '').trim(),
          String(args?.workspaceId ?? '').trim(),
        )
      },
    }),
    defineTool({
      name: 'agent_get_file',
      description: GET_FILE_DESCRIPTION,
      parameters: {
        path: {
          type: 'string',
          description: 'Absolute path of the file to read on the source environment.',
          required: true,
        },
        envId: {
          type: 'string',
          description: 'Environment to read from, from agent_list_envs. Omit to read this node.',
        },
        toPath: {
          type: 'string',
          description: 'Absolute path to write here. Omit to receive the bytes in memory instead of writing them.',
        },
        toOffset: {
          type: 'integer',
          description: 'Write at this byte offset in toPath instead of from the start. Continues or patches an '
            + 'existing file, and is how a large pull is resumed; the file must already exist.',
        },
        offset: {
          type: 'integer',
          description: 'First byte to read on the source. Omit for the start of the file.',
        },
        length: {
          type: 'integer',
          description: 'How many bytes to read from offset. Omit for the rest of the file.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing local file at toPath when writing from offset 0. Defaults to refusing.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string' },
            size: { type: 'integer' },
            path: { type: 'string' },
            offset: { type: 'integer' },
            length: { type: 'integer' },
            encoding: { type: 'string' },
            chunks: { type: 'array', items: { type: 'string' } },
            error: { type: 'string' },
          },
        },
        render: jsonRender,
      },
      async execute(args) {
        // Omitted stays omitted (the defaults depend on it); a supplied value must be a
        // real integer, so a string or a NaN is rejected by the schema rather than
        // silently becoming the default and reading the wrong window.
        const num = (value) => (value === undefined || value === null ? undefined : Number(value))
        return await getFile({
          path: String(args?.path ?? '').trim(),
          envId: String(args?.envId ?? '').trim(),
          toPath: String(args?.toPath ?? '').trim(),
          toOffset: num(args?.toOffset),
          offset: num(args?.offset),
          length: num(args?.length),
          overwrite: args?.overwrite === true,
        })
      },
    }),
  ]
}
