/**
 * Delivering one agent's message into another machine's session.
 *
 * The transport is the federation tunnel and the socket it already holds; the delivery
 * itself is `sessionController.prompt`, which is what dsh-bot uses to reach a session
 * from outside it. Both halves live here so the main node and an edge format a message
 * identically — a target that saw two different shapes would have to guess which side
 * composed it.
 *
 * **The receiving session sees a user message.** `prompt` hardcodes
 * `{ kind: 'user' }`, so there is no way to tell the model "this came from another
 * agent" through the message envelope. The prefix below is the compensation, and it is
 * composed here rather than accepted from the caller: a sender that could write its own
 * prefix could claim to be any environment.
 *
 * @module @yiln-dsh/dsh-gateway/agent-message
 */

import { randomUUID } from 'node:crypto'

/** Longest message a sender may submit, in characters. */
export const MAX_MESSAGE_CHARS = 8_000

/** Prefix marker. The receiver parses nothing from it; a human and the model read it. */
export const PREFIX = '[agent-message]'

/**
 * Compose the text a receiving session actually sees.
 *
 * @param message - `{ fromEnvId, fromSessionId, text }`.
 * @returns the prefixed body.
 */
export function composeBody(message) {
  const from = String(message.fromEnvId ?? '').trim() === '' ? 'unknown' : String(message.fromEnvId)
  const session = String(message.fromSessionId ?? '').trim() === '' ? 'unknown' : String(message.fromSessionId)
  return `${PREFIX} from=${from} session=${session}\n\n${message.text}`
}

/**
 * Validate what a sender submitted, before anything crosses the tunnel.
 *
 * @param request - the caller's arguments.
 * @returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function validateMessageRequest(request) {
  const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
  const text = typeof request?.text === 'string' ? request.text : ''
  if (sessionId === '') return { ok: false, error: 'sessionId is required' }
  // A session id is a UUID, and DSH itself writes it with a `session-` prefix —
  // `sessionController.create` returns exactly that, and it is what the session
  // directory on disk is called. Both spellings address the same session, so both are
  // accepted here; refusing the prefixed form would reject the id the harness hands out.
  // The canonical id keeps its `session-` prefix: that is what `resolveAgent` and the
  // session store expect, and stripping it produced "session not found" for a session
  // that `prompt` had just accepted. A bare UUID is normalised *up* to that form so a
  // caller who copied the id without the prefix still works.
  const prefixed = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(prefixed)) {
    return { ok: false, error: `sessionId must be a UUID, optionally "session-" prefixed; got "${sessionId.slice(0, 40)}"` }
  }
  if (text.trim() === '') return { ok: false, error: 'text must not be empty' }
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `text is ${text.length} characters; the limit is ${MAX_MESSAGE_CHARS}` }
  }
  const envId = typeof request?.envId === 'string' ? request.envId.trim() : ''
  return { ok: true, value: { sessionId: prefixed, text, envId } }
}

/**
 * Deliver one message into a session on **this** machine.
 *
 * This is the only place a message actually lands: the tunnel only carries it here, and
 * the environment that owns the session is the one that calls `prompt` — which is also
 * why an edge never asks its own user to log in again.
 *
 * @param options.sessions - the `sessionController` service.
 * @param options.logger - logger.
 * @param options.timeoutMs - how long `prompt` admission may take.
 * @returns `{ ok: true, accepted: true }` or `{ ok: false, error }`.
 */
export async function deliverToSession({ sessions, logger, timeoutMs = 30_000 }, message) {
  const body = composeBody(message)
  try {
    await sessions.prompt({
      requestId: randomUUID(),
      sessionId: message.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: body }],
    }, AbortSignal.timeout(timeoutMs))
    logger.info(`agent-message: delivered to session ${String(message.sessionId).slice(0, 8)}… from ${message.fromEnvId}`)
    return { ok: true, accepted: true }
  } catch (error) {
    // Reported, never swallowed: a sender that is told "accepted" when the session did
    // not exist has no way to discover the mistake.
    const reason = String(error?.message ?? error)
    logger.warn(`agent-message: delivery to ${String(message.sessionId).slice(0, 8)}… failed: ${reason}`)
    return { ok: false, error: reason }
  }
}
