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

test("keeps an uncapped session alive while it is used at least once per idle window", () => {
  const directory = temporaryDirectory();
  let now = 5_000_000;
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 0, idleTimeoutSeconds: 10, now: () => now });
    const record = store.create({ username: "admin" });
    for (let elapsed = 0; elapsed < 100; elapsed += 8) {
      now += 8000;
      assert.ok(store.touch(record.id, record.issuedAt), `session should survive ${String(elapsed + 8)}s of use`);
      assert.equal(record.expiresAt, now + 10_000);
    }
    now += 10_001;
    assert.equal(store.touch(record.id, record.issuedAt), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stops a session at an absolute ceiling that activity cannot extend", () => {
  const directory = temporaryDirectory();
  let now = 6_000_000;
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 10, idleTimeoutSeconds: 60, now: () => now });
    const record = store.create({ username: "admin" });
    assert.equal(record.expiresAt, now + 10_000);
    now += 8000;
    assert.ok(store.touch(record.id, record.issuedAt), "inside the ceiling the session is still valid");
    assert.equal(record.expiresAt, now + 2000, "the ceiling, not the idle window, bounds the deadline");
    now += 2001;
    assert.equal(store.touch(record.id, record.issuedAt), null, "activity cannot extend past the ceiling");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("re-evaluates persisted deadlines under the lifetime configured now", () => {
  const directory = temporaryDirectory();
  const file = join(directory, "sessions.json");
  let now = 10 * 24 * 3600 * 1000;
  const id = "B".repeat(22);
  const day = 24 * 3600 * 1000;
  try {
    // A record written while the previous 24-hour default was in force: its
    // stored deadline has already passed, but its last request was an hour ago.
    const stored = {
      id,
      username: "admin",
      issuedAt: now - 3 * day,
      lastSeenAt: now - 3600 * 1000,
      expiresAt: now - 2 * day,
      address: "unknown",
      userAgent: "",
      secure: false,
    };
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [stored] }));
    const extended = new SessionStore({ directory, maxAgeSeconds: 0, idleTimeoutSeconds: 3 * day, now: () => now });
    assert.ok(extended.touch(id, stored.issuedAt), "recent activity outlives the stricter deadline it was stored with");

    // The same record under a shorter idle window is expired, and no activity
    // may revive a deadline the current configuration does not grant.
    now = stored.lastSeenAt + 2 * 3600 * 1000;
    const shortened = new SessionStore({ directory, maxAgeSeconds: 0, idleTimeoutSeconds: 3600, now: () => now });
    assert.equal(shortened.touch(id, stored.issuedAt), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adopts a lifetime configured after the store was loaded", () => {
  const directory = temporaryDirectory();
  let now = 8_000_000;
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 0, idleTimeoutSeconds: 10, now: () => now });
    const record = store.create({ username: "admin" });
    assert.equal(record.expiresAt, now + 10_000);

    store.configure({ idleTimeoutSeconds: 3600 });
    assert.equal(record.expiresAt, now + 3600 * 1000, "the longer window applies to a session already in use");
    now += 10_001;
    assert.ok(store.touch(record.id, record.issuedAt), "activity that used to expire the session no longer does");

    store.configure({ maxAgeSeconds: 5 });
    assert.equal(record.expiresAt, record.issuedAt + 5000, "a ceiling added later still bounds the session");
    now += 5001;
    assert.equal(store.touch(record.id, record.issuedAt), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("advertises and renews a browser cookie lifetime before it lapses", () => {
  const directory = temporaryDirectory();
  let now = 7_000_000;
  const day = 24 * 3600 * 1000;
  try {
    const store = new SessionStore({ directory, maxAgeSeconds: 0, idleTimeoutSeconds: 3 * 24 * 3600, now: () => now });
    const record = store.create({ username: "admin" });
    assert.equal(store.cookieLifetimeSeconds(record), 3 * 24 * 3600);
    assert.equal(store.cookieRenewalDue(record), false, "a fresh cookie is not re-issued");
    now += day;
    store.touch(record.id, record.issuedAt);
    assert.equal(store.cookieRenewalDue(record), true);
    store.markCookieRenewed(record);
    assert.equal(store.cookieRenewalDue(record), false);
    assert.equal(store.cookieLifetimeSeconds(record), 3 * 24 * 3600);

    // A session with every bound disabled still hands the browser a finite
    // cookie, and refreshes it well inside that lifetime.
    const unbounded = new SessionStore({ directory: temporaryDirectory(), maxAgeSeconds: 0, idleTimeoutSeconds: 0, now: () => now });
    const forever = unbounded.create({ username: "admin" });
    assert.equal(unbounded.cookieLifetimeSeconds(forever), 30 * 24 * 3600);
    now += 400 * day;
    assert.ok(unbounded.touch(forever.id, forever.issuedAt));
    assert.equal(unbounded.cookieRenewalDue(forever), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
