/**
 * Subagent-session recovery helpers.
 *
 * A daemon restart kills every live Agent, including the continuable subagent
 * children a session had running. The core owns all of the child's durable
 * state: its session header records `origin: "subagent"` and the
 * `parentSession` it belongs to, and its log carries the continuable descriptor
 * naming the provider, model, and reasoning effort it was routed through. What
 * the core does not do is re-attach a child on its own — nothing walks the
 * store at startup looking for interrupted children.
 *
 * The one supported way back is `subagents.prompt()`, which cold-resumes an
 * absent direct child under an exact live parent and submits the message as a
 * distinct turn. Recovery therefore has two jobs: remember which children were
 * running, and deliver one continuation message per child once its parent is
 * live. The host half owns liveness and timing; the helpers here are pure.
 */

const CHILD_ORIGIN = "subagent";
const MAX_IDENTIFIER_LENGTH = 512;

function isIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && !/[\0\r\n]/u.test(value);
}

function isCwd(value) {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value);
}

/**
 * Build the registry record for one live subagent child, or `undefined` when
 * the agent is not one.
 *
 * Only the lineage is recorded: a child is re-attached from its own descriptor
 * rather than re-created from recorded options, so the model route the parent
 * was using must not be carried over here. The record always claims
 * `running: true`, so liveness is checked here — a record minted for an idle
 * child would ask the next start to continue a turn nobody interrupted.
 *
 * @param agent - a live Agent.
 * @returns a child registry record, or `undefined`.
 */
function childSessionRecord(agent) {
  const header = agent?.session?.header;
  if (agent?.status !== "running") return undefined;
  if (header?.origin !== CHILD_ORIGIN) return undefined;
  if (!isIdentifier(agent.id) || !isIdentifier(header.parentSession)) return undefined;

  const record = {
    sessionId: String(agent.id),
    origin: CHILD_ORIGIN,
    parentSession: String(header.parentSession),
    running: true,
  };
  if (isCwd(header.cwd)) record.cwd = header.cwd;
  return record;
}

/**
 * Validate and normalize one child record read back from the registry file.
 *
 * A record without a resolvable parent is unusable — recovery cannot deliver to
 * a child it cannot address — so it is rejected rather than half-restored.
 *
 * @param value - one `sessions[]` entry.
 * @returns the normalized record, or `undefined` when it is not a child record.
 */
function storedChildRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.origin !== CHILD_ORIGIN) return undefined;
  if (!isIdentifier(value.sessionId) || !isIdentifier(value.parentSession)) return undefined;
  if (value.running !== undefined && typeof value.running !== "boolean") return undefined;

  const record = {
    sessionId: String(value.sessionId),
    origin: CHILD_ORIGIN,
    parentSession: String(value.parentSession),
  };
  if (value.running !== undefined) record.running = value.running;
  if (isCwd(value.cwd)) record.cwd = value.cwd;
  return record;
}

/**
 * The `subagents.prompt` request that re-attaches one recorded child.
 *
 * `mode` is part of the control payload's schema, and `queue` is the delivery
 * an interrupted turn needs: it submits a distinct turn instead of steering a
 * step that no longer exists.
 *
 * @param input - the durable address, the caller-minted request identity, and
 *   the continuation text.
 * @returns a request for `subagents.prompt(request, signal)`.
 */
function childContinuationRequest({ parentSessionId, childSessionId, requestId, text }) {
  return {
    parentSessionId,
    childSessionId,
    mode: "continuable",
    delivery: "queue",
    requestId,
    content: [{ type: "text", text }],
  };
}

/**
 * The stable `subagents.prompt` refusals, and whether the record is worth
 * keeping for the next restart.
 *
 * Two are transient, and the record survives both for the next restart:
 * `delivery-unavailable` (the parent is live and the child resumable, but the
 * manager is draining or persistence is momentarily unavailable) and
 * `parent-unavailable`, which DSH throws *outside* its own rejection mapping
 * when the parent's liveness check fails between this walk and the delivery.
 * Treating that second one as an unexpected failure would still keep the record
 * — only `retry: false` deletes it — but it would be reported as a failure in
 * the diagnostics, which is what a reader would then chase. Everything else is
 * permanent for this child: a resumability or lineage fact does not change.
 */
const CHILD_REFUSALS = {
  "subagent/not-resumable": { decision: "skipped-not-resumable", retry: false },
  "subagent/unauthorized": { decision: "skipped-foreign-child", retry: false },
  "subagent/delivery-unavailable": { decision: "skipped-delivery-unavailable", retry: true },
  "subagent/parent-unavailable": { decision: "skipped-parent-unavailable", retry: true },
  // Not transient despite the name: DSH throws this when the deployment mounts
  // no session-projection registry at all, so a retry cannot change the answer.
  "subagent/projections-unavailable": { decision: "skipped-projections-unavailable", retry: false },
  "subagent/invalid-time-zone": { decision: "skipped-invalid-time-zone", retry: false },
  "subagent/attachment-invalid": { decision: "skipped-attachment-invalid", retry: false },
};

/**
 * Classify a thrown value from `subagents.prompt`.
 * @param error - the thrown value.
 * @returns `{ decision, retry }` for a known refusal, or `undefined` for an
 *   unexpected failure the caller should report as a failure.
 */
function childRefusal(error) {
  const code = error?.code;
  return typeof code === "string" ? CHILD_REFUSALS[code] : undefined;
}

export {
  CHILD_ORIGIN,
  childContinuationRequest,
  childRefusal,
  childSessionRecord,
  storedChildRecord,
};
