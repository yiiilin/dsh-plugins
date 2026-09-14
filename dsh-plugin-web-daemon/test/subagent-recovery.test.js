import assert from "node:assert/strict";
import test from "node:test";
import {
  childContinuationRequest,
  childRefusal,
  childSessionRecord,
  storedChildRecord,
} from "../lib/subagent-recovery.js";

const CHILD_HEADER = {
  type: "session",
  version: 3,
  id: "session-child",
  cwd: "/workspace",
  parentSession: "session-parent",
  isSeeded: false,
  origin: "subagent",
  delegationDepth: 1,
};

function liveChild(overrides = {}) {
  return {
    id: "session-child",
    status: "running",
    options: { provider: "subapi", model: "flash" },
    session: { header: { ...CHILD_HEADER, ...overrides.header } },
  };
}

test("records a running subagent child by lineage only", () => {
  const record = childSessionRecord(liveChild());
  assert.deepEqual(record, {
    sessionId: "session-child",
    origin: "subagent",
    parentSession: "session-parent",
    running: true,
    cwd: "/workspace",
  });
  // The recorded route belongs to the parent; a child is rebuilt from its own
  // descriptor, so carrying options here would restore the wrong model.
  assert.equal("agentOptions" in record, false);
  assert.equal("agentPreset" in record, false);
});

test("ignores a top-level session", () => {
  const agent = liveChild({ header: { origin: undefined, parentSession: undefined } });
  assert.equal(childSessionRecord(agent), undefined);
});

test("ignores a fork that carries a parent without the subagent origin", () => {
  // `sessions.fork()` also writes parentSession, so the origin check is what
  // separates a child from a forked top-level session.
  const agent = liveChild({ header: { origin: undefined } });
  assert.equal(childSessionRecord(agent), undefined);
});

test("ignores a child whose lineage cannot be addressed", () => {
  assert.equal(childSessionRecord(liveChild({ header: { parentSession: undefined } })), undefined);
  assert.equal(childSessionRecord(liveChild({ header: { parentSession: "" } })), undefined);
  assert.equal(childSessionRecord(liveChild({ header: { parentSession: "bad\nparent" } })), undefined);
  assert.equal(childSessionRecord({ id: "session-child", session: { header: CHILD_HEADER } }), undefined);
});

test("round-trips a child record through the registry file", () => {
  const record = childSessionRecord(liveChild());
  assert.deepEqual(storedChildRecord(record), record);
});

test("rejects stored child records that cannot be delivered to", () => {
  assert.equal(storedChildRecord(undefined), undefined);
  assert.equal(storedChildRecord("subagent"), undefined);
  assert.equal(storedChildRecord({ origin: "subagent", sessionId: "session-child" }), undefined);
  assert.equal(storedChildRecord({ origin: "subagent", parentSession: "session-parent" }), undefined);
  assert.equal(
    storedChildRecord({ origin: "subagent", sessionId: "s", parentSession: "p", running: "yes" }),
    undefined,
  );
  // A top-level record is not a child record; the caller keeps parsing it.
  assert.equal(storedChildRecord({ sessionId: "s", running: true }), undefined);
});

test("ignores unknown fields written by a newer version", () => {
  const record = storedChildRecord({
    sessionId: "session-child",
    origin: "subagent",
    parentSession: "session-parent",
    running: true,
    cwd: "/workspace",
    somethingNew: { nested: true },
  });
  assert.deepEqual(record, {
    sessionId: "session-child",
    origin: "subagent",
    parentSession: "session-parent",
    running: true,
    cwd: "/workspace",
  });
});

test("builds the queue prompt that re-attaches a child", () => {
  const request = childContinuationRequest({
    parentSessionId: "session-parent",
    childSessionId: "session-child",
    requestId: "request-1",
    text: "continue",
  });
  assert.deepEqual(request, {
    parentSessionId: "session-parent",
    childSessionId: "session-child",
    mode: "continuable",
    delivery: "queue",
    requestId: "request-1",
    content: [{ type: "text", text: "continue" }],
  });
});

test("keeps a record only when the refusal is transient", () => {
  assert.deepEqual(
    childRefusal({ code: "subagent/not-resumable" }),
    { decision: "skipped-not-resumable", retry: false },
  );
  assert.deepEqual(
    childRefusal({ code: "subagent/unauthorized" }),
    { decision: "skipped-foreign-child", retry: false },
  );
  assert.deepEqual(
    childRefusal({ code: "subagent/delivery-unavailable" }),
    { decision: "skipped-delivery-unavailable", retry: true },
  );
});

test("reports an unexpected failure as unclassified", () => {
  assert.equal(childRefusal(new Error("boom")), undefined);
  assert.equal(childRefusal({ code: "gateway/internal" }), undefined);
  assert.equal(childRefusal(undefined), undefined);
});
