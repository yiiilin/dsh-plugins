import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PASSKEY_ID_PATTERN, PasskeyStore } from "../passkey-store.js";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "dsh-passkey-store-test-"));
}

function credential(id = "credential-id") {
  return {
    id,
    publicKey: new Uint8Array([1, 2, 3, 4, 5]),
    counter: 0,
    transports: ["internal", "invalid"],
  };
}

test("persists passkey metadata without private key material", () => {
  const directory = temporaryDirectory();
  let now = 1_000;
  try {
    const store = new PasskeyStore({ directory, now: () => now });
    const added = store.add({ credential: credential(), name: "  Phone  ", deviceType: "multiDevice", backedUp: true });
    assert.equal(added.persisted, true);
    assert.match(added.record.id, PASSKEY_ID_PATTERN);
    assert.equal(added.record.name, "Phone");
    assert.deepEqual(store.list(), [{
      id: "credential-id",
      name: "Phone",
      createdAt: 1_000,
      lastUsedAt: null,
      deviceType: "multiDevice",
      backedUp: true,
      transports: ["internal"],
    }]);

    const raw = JSON.parse(readFileSync(join(directory, "passkeys.json"), "utf8"));
    assert.equal(raw.credentials[0].publicKey, "AQIDBAU");
    assert.equal("privateKey" in raw.credentials[0], false);
    assert.equal(statSync(join(directory, "passkeys.json")).mode & 0o077, 0);

    now = 2_000;
    const reloaded = new PasskeyStore({ directory, now: () => now });
    assert.deepEqual(reloaded.credential("credential-id"), {
      id: "credential-id",
      publicKey: Buffer.from([1, 2, 3, 4, 5]),
      counter: 0,
      transports: ["internal"],
    });
    assert.equal(reloaded.updateAuthentication("credential-id", 4, "multiDevice", true), true);
    assert.equal(reloaded.list()[0].lastUsedAt, 2_000);
    assert.equal(reloaded.credential("credential-id").counter, 4);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("consumes each challenge once and rejects mismatched or expired flows", () => {
  const directory = temporaryDirectory();
  let now = 10_000;
  try {
    const store = new PasskeyStore({ directory, now: () => now });
    const challenge = "challenge-one";
    store.createChallenge({ purpose: "register", challenge, sessionId: "session-1", rpId: "example.com", origin: "https://example.com", address: "192.0.2.1" });
    assert.equal(store.consumeChallenge(challenge, "register", { sessionId: "other", address: "192.0.2.1" }), null);
    assert.equal(store.consumeChallenge(challenge, "login", { sessionId: "session-1", address: "192.0.2.1" }), null);
    assert.equal(store.consumeChallenge(challenge, "register", { sessionId: "session-1", address: "192.0.2.1" }), null);

    const second = "challenge-two";
    store.createChallenge({ purpose: "login", challenge: second, rpId: "example.com", origin: "https://example.com", address: "192.0.2.1" });
    now += 5 * 60 * 1000;
    assert.equal(store.consumeChallenge(second, "login", { address: "192.0.2.1" }), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate credentials and revokes one record at a time", () => {
  const directory = temporaryDirectory();
  try {
    const store = new PasskeyStore({ directory });
    store.add({ credential: credential(), name: "First" });
    assert.throws(() => store.add({ credential: credential(), name: "Duplicate" }), /already registered/u);
    assert.deepEqual(store.remove("missing"), { existed: false, persisted: true });
    assert.deepEqual(store.remove("credential-id"), { existed: true, persisted: true });
    assert.equal(store.hasAny(), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
