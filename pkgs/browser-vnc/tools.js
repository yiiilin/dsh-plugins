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
 * @module @yiln-dsh/dsh-browser-vnc/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { INSTANCE_STATES } from './instances.js'

/** Render one canonical value as the single JSON text block the model reads. */
const jsonRender = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

/**
 * The list row schema. It mirrors the frozen HTTP row exactly — eight fields,
 * epoch seconds — plus the one conditional field a `failed` row adds, so the
 * tool and `GET /sessions` cannot describe the same table differently.
 *
 * `additionalProperties: false` stays on: the row is a closed shape, and a key
 * the table starts emitting without being declared here is a contract change
 * that should fail loudly rather than reach a model unannounced.
 */
const ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: '浏览器实例 id; pass this to the other browser_instance_ tools.' },
    state: { type: 'string', enum: INSTANCE_STATES },
    width: { type: 'integer' },
    height: { type: 'integer' },
    createdAt: { type: 'integer', description: 'Epoch seconds.' },
    ownerSessionId: {
      oneOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The session that owns this instance (实例归属); null when it has no owning session.',
    },
    lastActiveAt: { type: 'integer', description: 'Epoch seconds.' },
    viewers: { type: 'integer', description: 'Clients currently watching this instance.' },
    cdpPort: {
      type: 'integer',
      description: 'Chrome DevTools Protocol port for this instance. Pass it to `agent-browser connect <port>` to drive THIS browser.',
    },
    error: {
      type: 'string',
      description: 'Why the instance failed; present only on a failed row, absent on starting/ready rows.',
    },
  },
}

const LIST_DESCRIPTION = [
  'List the browser windows the user can see on their desktop (浏览器实例).',
  'Each row carries the instance id (浏览器实例 id), a `cdpPort` that drives exactly this browser,',
  'its state (starting | ready | failed), size, creation time, owning session (实例归属), last',
  'activity and viewer count. A failed row also carries `error`.',
  'To act on one of these windows, run `agent-browser connect <cdpPort>` and then use agent-browser',
  'commands (open/snapshot/click/fill/screenshot). Do NOT call `agent-browser open` without connecting',
  'first: that launches a private browser the user cannot see, and the window you meant to drive stays',
  'blank. Read ids here; never guess one, and never treat the first or only row as an implicit target.',
].join(' ')

const CREATE_DESCRIPTION = [
  'Open a visible browser window on the user\'s desktop (浏览器实例) and return its browser instance id plus the',
  '`cdpPort` that drives it.',
  'Use this when the user asks you to test a web page, check a UI, log into a site, take a screenshot,',
  'or walk through a workflow they should be able to watch. For automation nobody watches, use',
  '`agent-browser` on its own instead — that browser is headless and invisible.',
  'After creating: run `agent-browser connect <cdpPort>` to attach to THIS window, then drive it.',
  'The window appears in the sidebar 桌面 VNC panel and on the desktop, titled with its id.',
  'ownerSessionId records 实例归属: the owning session, fixed at creation and never reassigned. Omit it to own the new',
  'instance for the calling session, which is what makes it close when that session is disposed.',
].join(' ')

const RESIZE_DESCRIPTION = [
  'Set the viewport size of one browser window (浏览器实例) by its browser instance id',
  '(浏览器实例 id).',
  'Use this to test a page at a specific size — a 1920x1080 desktop, a 390x844 phone —',
  'without opening another browser. The sizes are the page viewport, not the window frame.',
  'A size that does not exist is an error rather than a silent success; nothing is resized',
  'on a guess.',
].join(' ')

const CLOSE_DESCRIPTION = [
  'Close one browser window (浏览器实例) by its browser instance id (浏览器实例 id).',
  'Closing is immediate and does not ask the user: the row leaves the list and the window disappears',
  'from their desktop. An id that does not exist is an error rather than a silent success:',
  'no other instance is substituted, and nothing is closed on a guess.',
  'This closes the browser only; it does not touch the session that owned it.',
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
export function browserInstanceTools({ list, create, close, resize }) {
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
        width: { type: 'integer', description: 'Viewport width in CSS pixels; omit for the configured default.' },
        height: { type: 'integer', description: 'Viewport height in CSS pixels; omit for the configured default.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'The new browser instance id.' },
            state: { type: 'string', const: 'starting' },
            cdpPort: {
              type: 'integer',
              description: 'CDP port for this instance; `agent-browser connect <cdpPort>` drives it.',
            },
            width: { type: 'integer' },
            height: { type: 'integer' },
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
        return create({
          ownerSessionId,
          ...(Number.isFinite(args.width) ? { width: args.width } : {}),
          ...(Number.isFinite(args.height) ? { height: args.height } : {}),
        })
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
    defineTool({
      name: 'browser_instance_resize',
      description: RESIZE_DESCRIPTION,
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Exact browser instance id to resize; an id that does not exist is an error.',
        },
        width: { type: 'integer', required: true, description: 'Viewport width in CSS pixels.' },
        height: { type: 'integer', required: true, description: 'Viewport height in CSS pixels.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'The instance that was resized.' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
        },
        render: jsonRender,
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return resize(args.id, { width: args.width, height: args.height })
      },
    }),
  ]
}
