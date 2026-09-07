import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import apply from "../index.js";

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

function contextFor(routeRef, persistence) {
  return {
    agents: {
      get() {
        return undefined;
      },
    },
    sessions: {
      get() {
        return undefined;
      },
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

test("accepts a unique sessionIds batch and deletes every persisted directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-delete-session-"));
  try {
    const ids = ["session-one", "session-two"];
    const paths = new Map();
    const headers = ids.map((id) => {
      const sessionDir = join(root, "_no-cwd", id);
      const path = join(sessionDir, "session.jsonl");
      paths.set(id, sessionDir);
      return { id, cwd: undefined, path, sessionDir };
    });
    for (const item of headers) {
      await mkdir(item.sessionDir, { recursive: true });
      await writeFile(item.path, `${item.id}\n`);
    }
    const persistence = {
      list: async () => headers,
      locate: (header) => ({ kind: "jsonl", path: header.path }),
    };
    const routeRef = {};
    apply(contextFor(routeRef, persistence));
    const res = response();

    await routeRef.route.handler(request({ sessionIds: ids, confirm: true }), res);

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {
      ok: true,
      results: [
        { sessionId: "session-one", deleted: true, materialized: true, removedDirectory: true },
        { sessionId: "session-two", deleted: true, materialized: true, removedDirectory: true },
      ],
    });
    for (const id of ids) await assert.rejects(() => stat(paths.get(id)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
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
