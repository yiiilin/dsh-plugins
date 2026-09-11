import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import apply from "../index.js";

const ARTIFACT = "session.v3.jsonl.zstd";

function request(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  };
}

function response() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

function contextFor(routeRef, persistence, overrides = {}) {
  return {
    agents: {
      get() {
        return undefined;
      },
      ...overrides.agents,
    },
    sessions: {
      get() {
        return undefined;
      },
      ...overrides.sessions,
    },
    sessionPersistence: persistence,
    webServer: {
      register(route) {
        routeRef.route = route;
        return () => {};
      },
    },
    on() {
      return () => {};
    },
    effect(setup) {
      return setup();
    },
  };
}

/**
 * A store laid out like the stock JSONL backend: one guarded directory per
 * session under a project directory, reported through `list()` as persistence
 * snapshots (`{ header, revision, sizeBytes }`) rather than bare headers.
 */
async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-delete-session-"));
  const artifacts = new Map();
  const headers = [];
  const projectDir = (header) => join(
    root,
    header.cwd === undefined ? "_no-cwd" : `--${header.cwd.replace(/^\/+/u, "").replace(/\//gu, "-")}--`,
  );

  return {
    root,
    headers,
    async add(header, options = {}) {
      const artifact = options.artifact ?? ARTIFACT;
      const dir = join(projectDir(header), header.id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, artifact), `${JSON.stringify(header)}\n`);
      if (options.tempFile !== undefined) await writeFile(join(dir, options.tempFile), "scratch");
      artifacts.set(header.id, { artifact, dir });
      headers.push(header);
      return dir;
    },
    dir(header) {
      return artifacts.get(header.id).dir;
    },
    persistence(overrideLocate) {
      return {
        list: async () => headers.map((header) => ({
          header,
          revision: "revision-1",
          sizeBytes: 1,
        })),
        // The stock backend always names the CURRENT generation, even when only
        // a historical generation has been materialized so far.
        locate: overrideLocate ?? ((header) => ({
          kind: "jsonl",
          path: join(artifacts.get(header.id).dir, ARTIFACT),
        })),
      };
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("deletes a session with every subagent session delegated from it, at any depth", async () => {
  const store = await storeFixture();
  try {
    const parent = { id: "session-parent", cwd: undefined, isSeeded: false };
    const childA = { id: "session-child-a", cwd: undefined, isSeeded: false, parentSession: parent.id, origin: "subagent", delegationDepth: 1 };
    const childB = { id: "session-child-b", cwd: undefined, isSeeded: false, parentSession: parent.id, origin: "subagent", delegationDepth: 1 };
    const grandchild = { id: "session-grandchild", cwd: undefined, isSeeded: false, parentSession: childA.id, origin: "subagent", delegationDepth: 2 };
    // Fork lineage: names the parent but is not a subagent, so a user can still
    // open it and deleting the source must leave it alone.
    const forked = { id: "session-forked", cwd: undefined, isSeeded: true, parentSession: parent.id };
    const unrelated = { id: "session-unrelated", cwd: undefined, isSeeded: false };
    for (const header of [parent, childA, childB, grandchild, forked, unrelated]) await store.add(header);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence()));
    const res = response();

    await routeRef.route.handler(request({ sessionId: parent.id, confirm: true }), res);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.sessionId, parent.id);
    assert.equal(body.deleted, true);
    assert.equal(body.materialized, true);
    assert.equal(body.removedDirectory, true);
    assert.deepEqual(
      body.subagentSessionIds.slice().sort(),
      [childA.id, childB.id, grandchild.id].sort(),
    );
    for (const header of [parent, childA, childB, grandchild]) {
      assert.equal(await exists(store.dir(header)), false, `${header.id} directory should be gone`);
    }
    assert.equal(await exists(store.dir(forked)), true, "a forked session is not a subagent and must survive");
    assert.equal(await exists(store.dir(unrelated)), true);
  } finally {
    await store.cleanup();
  }
});

test("removes a legacy session that is still stored as the v0 generation", async () => {
  const store = await storeFixture();
  try {
    const header = { id: "session-legacy", cwd: "/tmp/example", isSeeded: false };
    await store.add(header, { artifact: "session.jsonl.zstd", tempFile: "scratch.txt" });

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence()));
    const res = response();
    await routeRef.route.handler(request({ sessionId: header.id, confirm: true }), res);

    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    // The current generation was never materialized for this session, but the
    // directory holding the legacy artifact is removed all the same.
    assert.equal(body.materialized, false);
    assert.equal(body.removedDirectory, true);
    assert.equal(await exists(store.dir(header)), false);
  } finally {
    await store.cleanup();
  }
});

test("refuses a persistence location that is not a guarded session directory", async () => {
  const store = await storeFixture();
  try {
    const header = { id: "session-guarded", cwd: undefined, isSeeded: false };
    await store.add(header);
    const other = { id: "session-neighbour", cwd: undefined, isSeeded: false };
    await store.add(other);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence(() => ({
      kind: "jsonl",
      // A backend that points this session at a different session's directory
      // must not be able to delete it.
      path: join(store.dir(other), ARTIFACT),
    }))));
    const res = response();
    await routeRef.route.handler(request({ sessionId: header.id, confirm: true }), res);

    assert.equal(res.status, 501);
    assert.equal(JSON.parse(res.body).ok, false);
    assert.equal(await exists(store.dir(other)), true);
    assert.equal(await exists(store.dir(header)), true);
  } finally {
    await store.cleanup();
  }
});

test("refuses a persistence location whose artifact is not a session log", async () => {
  const store = await storeFixture();
  try {
    const header = { id: "session-foreign", cwd: undefined, isSeeded: false };
    await store.add(header);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence((meta) => ({
      kind: "jsonl",
      path: join(store.dir(meta), "notes.jsonl"),
    }))));
    const res = response();
    await routeRef.route.handler(request({ sessionId: header.id, confirm: true }), res);

    assert.equal(res.status, 501);
    assert.equal(await exists(store.dir(header)), true);
  } finally {
    await store.cleanup();
  }
});

test("refuses a live session whose teardown handle was never observed", async () => {
  const store = await storeFixture();
  try {
    const header = { id: "session-live", cwd: undefined, isSeeded: false };
    await store.add(header);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence(), {
      agents: { get: (id) => (id === header.id ? { id, session: { header } } : undefined) },
    }));
    const res = response();
    await routeRef.route.handler(request({ sessionId: header.id, confirm: true }), res);

    assert.equal(res.status, 409);
    assert.match(JSON.parse(res.body).error, /restart dsh web/u);
    assert.equal(await exists(store.dir(header)), true);
  } finally {
    await store.cleanup();
  }
});

test("reports a batch target already removed by an earlier cascade instead of failing", async () => {
  const store = await storeFixture();
  try {
    const parent = { id: "session-batch-parent", cwd: undefined, isSeeded: false };
    const child = { id: "session-batch-child", cwd: undefined, isSeeded: false, parentSession: parent.id, origin: "subagent", delegationDepth: 1 };
    for (const header of [parent, child]) await store.add(header);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence()));
    const res = response();
    await routeRef.route.handler(request({ sessionIds: [parent.id, child.id], confirm: true }), res);

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      results: [
        {
          sessionId: parent.id,
          deleted: true,
          materialized: true,
          removedDirectory: true,
          subagentSessionIds: [child.id],
        },
        { sessionId: child.id, deleted: true, alreadyRemoved: true },
      ],
    });
    assert.equal(await exists(store.dir(parent)), false);
    assert.equal(await exists(store.dir(child)), false);
  } finally {
    await store.cleanup();
  }
});

test("deletes every persisted directory in a unique sessionIds batch", async () => {
  const store = await storeFixture();
  try {
    const first = { id: "session-one", cwd: undefined, isSeeded: false };
    const second = { id: "session-two", cwd: undefined, isSeeded: false };
    for (const header of [first, second]) await store.add(header);

    const routeRef = {};
    apply(contextFor(routeRef, store.persistence()));
    const res = response();
    await routeRef.route.handler(request({ sessionIds: [first.id, second.id], confirm: true }), res);

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).results, [
      { sessionId: first.id, deleted: true, materialized: true, removedDirectory: true, subagentSessionIds: [] },
      { sessionId: second.id, deleted: true, materialized: true, removedDirectory: true, subagentSessionIds: [] },
    ]);
    assert.equal(await exists(store.dir(first)), false);
    assert.equal(await exists(store.dir(second)), false);
  } finally {
    await store.cleanup();
  }
});

test("rejects ambiguous or invalid batch payloads before touching persistence", async () => {
  const calls = [];
  const persistence = {
    list: async () => {
      calls.push("list");
      return [];
    },
    locate: () => undefined,
  };
  const routeRef = {};
  apply(contextFor(routeRef, persistence));

  const both = response();
  await routeRef.route.handler(request({ sessionId: "one", sessionIds: ["two"], confirm: true }), both);
  assert.equal(both.status, 400);

  const invalid = response();
  await routeRef.route.handler(request({ sessionIds: ["duplicate", "duplicate"], confirm: true }), invalid);
  assert.equal(invalid.status, 400);

  const tooMany = response();
  await routeRef.route.handler(request({ sessionIds: Array.from({ length: 101 }, (_, index) => `session-${index}`), confirm: true }), tooMany);
  assert.equal(tooMany.status, 400);
  assert.deepEqual(calls, []);
});

test("reports a missing session as not found", async () => {
  const store = await storeFixture();
  try {
    const routeRef = {};
    apply(contextFor(routeRef, store.persistence()));
    const res = response();
    await routeRef.route.handler(request({ sessionId: "session-absent", confirm: true }), res);
    assert.equal(res.status, 404);
    assert.equal(JSON.parse(res.body).error, "session not found");
  } finally {
    await store.cleanup();
  }
});
