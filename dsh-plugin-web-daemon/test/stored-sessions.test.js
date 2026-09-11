import assert from "node:assert/strict";
import test from "node:test";
import { headerOf, persistedHeadersFromList, readStoredSession } from "../lib/stored-sessions.js";

const HEADER = { type: "session", version: 3, id: "session-a", cwd: "/workspace", agentPreset: "yiln" };

test("indexes list() snapshots by session id", () => {
  const persisted = persistedHeadersFromList([
    { header: HEADER, revision: "1", sizeBytes: 10 },
    { header: { ...HEADER, id: "session-b" }, revision: "2", sizeBytes: 20 },
  ]);
  assert.deepEqual([...persisted.keys()], ["session-a", "session-b"]);
  assert.equal(persisted.get("session-a").cwd, "/workspace");
});

test("accepts a bare header list from an older backend", () => {
  const persisted = persistedHeadersFromList([HEADER]);
  assert.equal(persisted.get("session-a"), HEADER);
});

test("ignores entries without a resolvable id", () => {
  // The old bug: a snapshot read as a header produced String(undefined) keys, so
  // every lookup missed and every session was pruned as not persisted.
  const persisted = persistedHeadersFromList([{ revision: "1", sizeBytes: 1 }, null, "junk"]);
  assert.equal(persisted.size, 0);
  assert.equal(headerOf({ revision: "1" }), undefined);
});

test("reads stat() + open('read') as { meta, events }", async () => {
  const events = [{ type: "request/header", seq: 3, data: { header: { config: {} } } }];
  const closed = [];
  const persistence = {
    async stat(id) {
      assert.equal(id, "session-a");
      return { header: HEADER, revision: "1", sizeBytes: 10 };
    },
    async open(id, access) {
      assert.equal(id, "session-a");
      assert.equal(access, "read");
      return { async read() { return { eventState: "detached", events }; }, async close() { closed.push(id); } };
    },
  };
  const session = await readStoredSession(persistence, "session-a");
  assert.equal(session.meta, HEADER);
  assert.deepEqual(session.events, events);
  assert.deepEqual(closed, ["session-a"]);
});

test("closes the read handle even when the log read fails", async () => {
  const closed = [];
  const persistence = {
    async stat() { return { header: HEADER, revision: "1" }; },
    async open() {
      return {
        async read() { throw new Error("corrupt tail"); },
        async close() { closed.push("closed"); },
      };
    },
  };
  await assert.rejects(readStoredSession(persistence, "session-a"), /corrupt tail/u);
  assert.deepEqual(closed, ["closed"]);
});

test("reports an unpersisted session as undefined", async () => {
  assert.equal(await readStoredSession({ async stat() { return undefined; } }, "session-a"), undefined);
  assert.equal(await readStoredSession(undefined, "session-a"), undefined);
});

test("survives a backend without stat or open", async () => {
  assert.equal(await readStoredSession({}, "session-a"), undefined);
});
