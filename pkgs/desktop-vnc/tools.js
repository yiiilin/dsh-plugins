/**
 * desktop-vnc Host half — the agent tools over the browser instance table.
 *
 * Three tools, all prefixed `browser_instance_`, and nothing else:
 *
 * - `browser_instance_list` reports the table.
 * - `browser_instance_create` opens one instance and answers with its id.
 * - `browser_instance_close` closes exactly the instance named.
 *
 * Two rules from `GLOSSARY.md` decide the shape of every description here:
 *
 * - **The id is the only way to name a browser instance.** A tool whose id does not
 *   exist reports an error; it never falls back to "the most recent one" or
 *   "the only one", and it never creates one on the caller's behalf. A silent
 *   fallback is worse than a failure: the agent would believe it is driving the
 *   browser it named while a different one is being driven.
 * - **Ownership (实例归属) is fixed at creation.** The owning session is recorded
 *   when the instance opens and never changes, which is what lets
 *   `session/disposed` collect exactly that session's browsers.
 *
 * The table itself is passed in as plain functions rather than imported, so the
 * plugin's own `create` wrapper (which mounts the per-instance WS route) is the
 * one the tool drives — a tool that called the registry directly would produce
 * an instance no viewer could ever connect to.
 *
 * @module @yiln-dsh/dsh-desktop-vnc/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** The three states a browser instance can be in, as the list reports them. */
const STATES = ['starting', 'ready', 'failed']

/** Render one canonical value as the single JSON text block the model reads. */
const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

/**
 * The list row schema. It mirrors the frozen HTTP row exactly — eight fields,
 * epoch seconds — so the tool and `GET /sessions` cannot describe the same table
 * differently.
 */
const ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '浏览器实例 id; pass this to the other browser_instance_ tools.' },
    state: { type: 'string', enum: STATES },
    width: { type: 'integer' },
    height: { type: 'integer' },
    createdAt: { type: 'integer', description: 'Epoch seconds.' },
    ownerSessionId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The session that owns this instance (实例归属); null when it has no owning session.',
    },
    lastActiveAt: { type: 'integer', description: 'Epoch seconds.' },
    viewers: { type: 'integer', description: 'Clients currently watching this instance.' },
  },
}

const LIST_DESCRIPTION = [
  'List every browser instance (浏览器实例) held by this dsh process, in creation order.',
  'Each row carries its browser instance id (浏览器实例 id), state (starting | ready | failed), size,',
  'creation time, owning session (实例归属), last activity and current viewer count.',
  'This is the only way to learn ids: read them here, then pass one to browser_instance_close.',
  'Do not guess an id, and do not treat the first, newest or only row as an implicit target.',
].join(' ')

const CREATE_DESCRIPTION = [
  'Create one browser instance (浏览器实例) and answer with its browser instance id (浏览器实例 id) and',
  'initial state (starting; it becomes ready or failed shortly after).',
  'ownerSessionId records 实例归属: the owning session, fixed at creation and never reassigned.',
  'Omit it to own the new instance for the calling session, which is what makes it close when that',
  'session is disposed.',
  'Creating is always explicit: this tool is the only way an instance appears, and it never reuses or',
  'takes over an existing one.',
].join(' ')

const CLOSE_DESCRIPTION = [
  'Close exactly the browser instance (浏览器实例) named by `id`.',
  '`id` must be a browser instance id (浏览器实例 id) returned by browser_instance_create or',
  'browser_instance_list.',
  'An id that does not exist is an error: nothing is closed, no other instance is substituted (not the',
  'most recent, not the only one), and no new instance is created. Close the instance you actually mean,',
  'or list first to get the right id.',
].join(' ')

/**
 * Build the three tool definitions over one browser instance table.
 *
 * @param {object} table the operations the tools drive.
 * @param {() => Array<object>} table.list the flat table rows.
 * @param {(options: {ownerSessionId?: string|null}) => {id: string, state: string}} table.create
 *   the plugin's create wrapper (mounts the instance's route as a side effect).
 * @param {(id: string) => Promise<{closed: true}>} table.close closes exactly that id, and rejects
 *   when it does not exist.
 * @returns {object[]} registry-ready tool definitions, in listing order.
 */
export function browserInstanceTools({ list, create, close }) {
  return [
    defineTool({
      name: 'browser_instance_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: {
        schema: { type: 'array', items: ROW_SCHEMA },
        render: jsonRender,
      },
      async execute() {
        return list()
      },
    }),
    defineTool({
      name: 'browser_instance_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        ownerSessionId: {
          type: 'string',
          description: 'Owning session id (实例归属), fixed at creation. Omit to own it for the calling session.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'The new browser instance id.' },
            state: { type: 'string', const: 'starting' },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        // The caller's session is the truthful owner when the model does not name
        // one: an agent does not reliably know its own session id, and a wrong
        // owner would either leak the instance or close it with another session.
        const ownerSessionId = typeof args.ownerSessionId === 'string' && args.ownerSessionId !== ''
          ? args.ownerSessionId
          : (exec.agent?.session?.id ?? null)
        return create({ ownerSessionId })
      },
    }),
    defineTool({
      name: 'browser_instance_close',
      description: CLOSE_DESCRIPTION,
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Exact browser instance id to close; an id that does not exist is an error.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { closed: { type: 'boolean', const: true } },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return close(args.id)
      },
    }),
  ]
}
