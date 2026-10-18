import { existsSync, mkdirSync, readFileSync, lstatSync, chmodSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const PASSKEY_STORE_VERSION = 1;
export const PASSKEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,1024}$/u;
const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PASSKEY_MAX_CHALLENGES = 128;
const TRANSPORTS = new Set(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);

function sanitizeName(value) {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 80);
  return name;
}

function validBase64Url(value) {
  return typeof value === "string" && value !== "" && /^[A-Za-z0-9_-]+$/u.test(value);
}

function normalizeTransports(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string" && TRANSPORTS.has(entry)))];
}

function normalizeCredential(value) {
  if (value === null || typeof value !== "object") return null;
  if (!PASSKEY_ID_PATTERN.test(value.id) || !validBase64Url(value.publicKey)) return null;
  if (!Number.isSafeInteger(value.counter) || value.counter < 0) return null;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) return null;
  if (value.lastUsedAt !== null && value.lastUsedAt !== undefined
    && (!Number.isSafeInteger(value.lastUsedAt) || value.lastUsedAt < value.createdAt)) return null;
  try {
    const publicKey = Buffer.from(value.publicKey, "base64url");
    if (publicKey.length === 0) return null;
  } catch {
    return null;
  }
  return {
    id: value.id,
    name: sanitizeName(value.name),
    publicKey: value.publicKey,
    counter: value.counter,
    transports: normalizeTransports(value.transports),
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt ?? null,
    deviceType: value.deviceType === "multiDevice" ? "multiDevice" : "singleDevice",
    backedUp: value.backedUp === true,
  };
}

function publicCredential(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    deviceType: record.deviceType,
    backedUp: record.backedUp,
    transports: record.transports,
  };
}

export class PasskeyStore {
  records = new Map();
  #directory;
  #file;
  #logger;
  #now;
  #challenges = new Map();

  constructor({ directory, now = () => Date.now(), logger } = {}) {
    if (typeof directory !== "string" || directory === "") throw new Error("passkey store directory is required");
    this.#directory = directory;
    this.#file = join(directory, "passkeys.json");
    this.#now = now;
    this.#logger = logger;
    this.#load();
  }

  #load() {
    if (!existsSync(this.#file)) return;
    try {
      if (!lstatSync(this.#file).isFile()) throw new Error("persistent passkey store must be a regular file");
      chmodSync(this.#file, 0o600);
      const parsed = JSON.parse(readFileSync(this.#file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || parsed.version !== PASSKEY_STORE_VERSION || !Array.isArray(parsed.credentials)) return;
      for (const value of parsed.credentials) {
        const record = normalizeCredential(value);
        if (record !== null) this.records.set(record.id, record);
      }
    } catch (error) {
      this.#logger?.warn?.("auth-webserver: persistent passkey store could not be read: %s", error);
    }
  }

  persist() {
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({ version: PASSKEY_STORE_VERSION, credentials: [...this.records.values()] })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#file);
      chmodSync(this.#file, 0o600);
      return true;
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup after an interrupted atomic write.
      }
      this.#logger?.warn?.("auth-webserver: persistent passkey store could not be written: %s", error);
      return false;
    }
  }

  hasAny() {
    return this.records.size > 0;
  }

  list() {
    return [...this.records.values()]
      .sort((left, right) => (right.lastUsedAt ?? right.createdAt) - (left.lastUsedAt ?? left.createdAt))
      .map(publicCredential);
  }

  credential(id) {
    const record = this.records.get(id);
    if (record === undefined) return null;
    return {
      id: record.id,
      publicKey: Buffer.from(record.publicKey, "base64url"),
      counter: record.counter,
      transports: record.transports,
    };
  }

  add({ credential, name, deviceType, backedUp } = {}) {
    if (credential === null || typeof credential !== "object") throw new Error("invalid passkey credential");
    const id = credential.id;
    const publicKey = Buffer.from(credential.publicKey ?? []).toString("base64url");
    const record = normalizeCredential({
      id,
      publicKey,
      counter: credential.counter,
      transports: credential.transports,
      name,
      createdAt: this.#now(),
      lastUsedAt: null,
      deviceType,
      backedUp,
    });
    if (record === null) throw new Error("invalid passkey credential");
    if (this.records.has(record.id)) throw new Error("passkey is already registered");
    this.records.set(record.id, record);
    const persisted = this.persist();
    if (!persisted) this.records.delete(record.id);
    return { record, persisted };
  }

  updateAuthentication(id, counter, deviceType, backedUp) {
    const record = this.records.get(id);
    if (record === undefined || !Number.isSafeInteger(counter) || counter < 0) return false;
    const previous = {
      counter: record.counter,
      lastUsedAt: record.lastUsedAt,
      deviceType: record.deviceType,
      backedUp: record.backedUp,
    };
    record.counter = counter;
    record.lastUsedAt = this.#now();
    if (deviceType === "multiDevice" || deviceType === "singleDevice") record.deviceType = deviceType;
    if (backedUp === true) record.backedUp = true;
    if (!this.persist()) {
      Object.assign(record, previous);
      return false;
    }
    return true;
  }

  remove(id) {
    const record = this.records.get(id);
    if (record === undefined) return { existed: false, persisted: true };
    this.records.delete(id);
    const persisted = this.persist();
    if (!persisted) this.records.set(id, record);
    return { existed: true, persisted };
  }

  createChallenge({ purpose, challenge, sessionId, rpId, origin, address } = {}) {
    this.#pruneChallenges();
    if (typeof challenge !== "string" || challenge === "") throw new Error("passkey challenge is required");
    const now = this.#now();
    while (this.#challenges.size >= PASSKEY_MAX_CHALLENGES) {
      const oldest = this.#challenges.keys().next().value;
      if (oldest === undefined) break;
      this.#challenges.delete(oldest);
    }
    const pending = {
      purpose,
      challenge,
      sessionId: typeof sessionId === "string" ? sessionId : null,
      rpId,
      origin,
      address: typeof address === "string" ? address : null,
      createdAt: now,
      expiresAt: now + PASSKEY_CHALLENGE_TTL_MS,
    };
    this.#challenges.set(challenge, pending);
    return pending;
  }

  consumeChallenge(challenge, purpose, { sessionId, address } = {}) {
    this.#pruneChallenges();
    if (typeof challenge !== "string") return null;
    const pending = this.#challenges.get(challenge);
    if (pending === undefined) return null;
    this.#challenges.delete(challenge);
    if (pending.purpose !== purpose) return null;
    if (pending.sessionId !== null && pending.sessionId !== sessionId) return null;
    if (pending.address !== null && pending.address !== address) return null;
    return pending;
  }

  #pruneChallenges(now = this.#now()) {
    for (const [challenge, pending] of this.#challenges) {
      if (pending.expiresAt <= now) this.#challenges.delete(challenge);
    }
  }
}

export { normalizeCredential, normalizeTransports, publicCredential, sanitizeName };
