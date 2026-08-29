import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SESSION_ID_PATTERN, SessionStore } from "../session-store.js";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "dsh-session-store-test-"));
}

test("reloads persisted sessions and lists newest activity first", () => {
  const directory = temporaryDirectory();
  let now = 1_000_000;
  try {
    const first = new SessionStore({ directory, maxAgeSeconds: 3600, idleTimeoutSeconds: 1800, now: () => now });
    const older = first.create({ username: "admin", address: "192.0.2.10", userAgent: "Desktop", secure: true });
    now += 1000;
    const newer = first.create({ username: "admin", address: "192.0.2.11", userAgent: "Mobile", secure: true });
    assert.match(older.id, SESSION_ID_PATTERN);
    assert.match(newer.id, SESSION_ID_PATTERN);
    assert.notEqual(older.id, newer.id);

    now += 1000;
    const reloaded = new SessionStore({ directory, maxAgeSeconds: 3600, idleTimeoutSeconds: 1800, now: () => now });
    const clients = reloaded.list(newer.id);
    assert.deepEqual(clients.map((client) => client.id), [newer.id, older.id]);
    assert.equal(clients[0].current, true);
    assert.equal(clients[0].address, "192.0.2.11");
    assert.equal(clients[1].userAgent, "Desktop");

    const mode = statSync(join(directory, "sessions.json")).mode & 0o777;
    assert.equal(mode & 0o077, 0);
    const stored = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"));
    assert.equal(stored.sessions.some((entry) => entry.token), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps a session alive across reload until idle or absolute expiry", () => {
  const directory = temporaryDirectory();
  let now = 2_000_000;
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 60, idleTimeoutSeconds: 10, now: () => now });
    const record = store.create({ username: "admin" });
    now += 4000;
    assert.ok(store.touch(record.id, record.issuedAt));
    now += 4000;
    const reloaded = new SessionStore({ directory, maxAgeSeconds: 60, idleTimeoutSeconds: 10, now: () => now });
    assert.ok(reloaded.touch(record.id, record.issuedAt));
    now += 10_001;
    assert.equal(reloaded.touch(record.id, record.issuedAt), null);
    assert.deepEqual(reloaded.list(record.id), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revokes one session without affecting another and can revoke all", () => {
  const directory = temporaryDirectory();
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 3600, idleTimeoutSeconds: 1800 });
    const first = store.create({ username: "admin" });
    const second = store.create({ username: "admin" });
    assert.equal(store.revoke(first.id), true);
    assert.equal(store.revoke(first.id), false);
    assert.deepEqual(store.list(undefined).map((client) => client.id), [second.id]);
    assert.equal(store.revokeAll(), true);
    assert.deepEqual(store.list(undefined), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores malformed persisted records", () => {
  const directory = temporaryDirectory();
  try {
    const file = join(directory, "sessions.json");
    const validId = "A".repeat(22);
    const valid = { id: validId, username: "admin", issuedAt: 100, lastSeenAt: 100, expiresAt: 1000, address: "unknown", userAgent: "", secure: false };
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [valid, { id: "bad" }, null] }));
    const store = new SessionStore({ directory, maxAgeSeconds: 3600, idleTimeoutSeconds: 1800, now: () => 200 });
    assert.equal(store.records.size, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
