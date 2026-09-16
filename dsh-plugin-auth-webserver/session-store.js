import { existsSync, mkdirSync, readFileSync, lstatSync, chmodSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const SESSION_STORE_VERSION = 1;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
export const SESSION_PERSIST_INTERVAL_MS = 30_000;
/** A browser cookie is re-issued once this fraction of its lifetime has passed. */
export const SESSION_COOKIE_RENEW_DIVISOR = 3;
/** Deadline of a session whose configuration disables every lifetime bound. */
export const SESSION_NEVER_EXPIRES_AT = Number.MAX_SAFE_INTEGER;
/** Browser-cookie lifetime advertised when the session itself is unbounded. */
export const SESSION_FALLBACK_COOKIE_LIFETIME_MS = 30 * 24 * 3600 * 1000;

function sanitizeUserAgent(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 512);
}

function normalizeSessionRecord(value) {
  if (value === null || typeof value !== "object") return null;
  if (!SESSION_ID_PATTERN.test(value.id)) return null;
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.lastSeenAt) || !Number.isSafeInteger(value.expiresAt)) return null;
  if (value.expiresAt <= value.issuedAt) return null;
  return {
    id: value.id,
    authEpoch: Number.isSafeInteger(value.authEpoch) && value.authEpoch >= 0 ? value.authEpoch : 0,
    username: typeof value.username === "string" ? value.username.slice(0, 256) : "admin",
    issuedAt: value.issuedAt,
    lastSeenAt: Math.max(value.issuedAt, value.lastSeenAt),
    expiresAt: value.expiresAt,
    // Records written before the cookie lifetime was refreshed on activity
    // carry no `renewedAt`; treating them as never renewed re-issues their
    // browser cookie on the next request.
    renewedAt: Number.isSafeInteger(value.renewedAt) ? Math.max(value.issuedAt, value.renewedAt) : value.issuedAt,
    address: typeof value.address === "string" ? value.address.slice(0, 128) : "unknown",
    userAgent: sanitizeUserAgent(value.userAgent),
    secure: value.secure === true,
  };
}

function publicSession(record, currentId) {
  return {
    id: record.id,
    username: record.username,
    issuedAt: record.issuedAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    address: record.address,
    userAgent: record.userAgent,
    secure: record.secure,
    current: record.id === currentId,
  };
}

/**
 * Persistent registry for signed browser sessions; it stores no bearer token.
 *
 * A record's deadline slides: every accepted request moves it to `lastSeenAt +
 * idleTimeoutSeconds`, so a browser that keeps being used never has to log in
 * again. `maxAgeSeconds` is an optional ceiling that activity cannot extend;
 * zero leaves the idle window as the only bound.
 */
export class SessionStore {
  records = new Map();
  #directory;
  #file;
  #maxAgeMs;
  #idleTimeoutMs;
  #now;
  #logger;
  #lastPersistAt = 0;

  constructor({ directory, maxAgeSeconds, idleTimeoutSeconds, now = () => Date.now(), logger } = {}) {
    if (typeof directory !== "string" || directory === "") throw new Error("session store directory is required");
    this.#directory = directory;
    this.#file = join(directory, "sessions.json");
    this.#maxAgeMs = Math.max(0, Number(maxAgeSeconds) || 0) * 1000;
    this.#idleTimeoutMs = Math.max(0, Number(idleTimeoutSeconds) || 0) * 1000;
    this.#now = now;
    this.#logger = logger;
    this.#load();
    this.#adoptConfiguredLifetime();
  }

  #load() {
    if (!existsSync(this.#file)) return;
    try {
      if (!lstatSync(this.#file).isFile()) throw new Error("persistent session store must be a regular file");
      chmodSync(this.#file, 0o600);
      const parsed = JSON.parse(readFileSync(this.#file, "utf8"));
      if (parsed === null || typeof parsed !== "object" || parsed.version !== SESSION_STORE_VERSION || !Array.isArray(parsed.sessions)) return;
      for (const value of parsed.sessions) {
        const record = normalizeSessionRecord(value);
        if (record !== null) this.records.set(record.id, record);
      }
    } catch (error) {
      this.#logger?.warn?.("auth-webserver: persistent session store could not be read: %s", error);
    }
  }

  /**
   * Re-evaluate persisted deadlines under the configuration in force now, so a
   * deployment that lengthens its lifetime keeps the sessions its own recent
   * activity already earned, and one that shortens it does not honour a
   * deadline the stricter rule no longer grants.
   */
  #adoptConfiguredLifetime() {
    let changed = false;
    for (const record of this.records.values()) {
      const deadline = this.#deadline(record.issuedAt, record.lastSeenAt);
      if (deadline === record.expiresAt) continue;
      record.expiresAt = deadline;
      changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * Adopt a configuration changed while the store is loaded: deadlines are
   * re-evaluated immediately, so a longer window takes effect on the running
   * gateway instead of at its next restart.
   */
  configure({ maxAgeSeconds, idleTimeoutSeconds } = {}) {
    if (maxAgeSeconds !== undefined) this.#maxAgeMs = Math.max(0, Number(maxAgeSeconds) || 0) * 1000;
    if (idleTimeoutSeconds !== undefined) this.#idleTimeoutMs = Math.max(0, Number(idleTimeoutSeconds) || 0) * 1000;
    this.#adoptConfiguredLifetime();
  }

  /** Deadline earned by one record: the earliest configured bound, or none. */
  #deadline(issuedAt, lastSeenAt) {
    const bounds = [];
    if (this.#idleTimeoutMs > 0) bounds.push(lastSeenAt + this.#idleTimeoutMs);
    if (this.#maxAgeMs > 0) bounds.push(issuedAt + this.#maxAgeMs);
    return bounds.length === 0 ? SESSION_NEVER_EXPIRES_AT : Math.min(...bounds);
  }

  /**
   * Lifetime to advertise to the browser for one record. A cookie is always
   * finite — a browser that never expires it would keep presenting a bearer
   * value long after the server stopped accepting it.
   */
  #advertisedLifetimeMs(record, now) {
    const bounds = [];
    if (this.#idleTimeoutMs > 0) bounds.push(this.#idleTimeoutMs);
    if (this.#maxAgeMs > 0) bounds.push(this.#maxAgeMs);
    if (record.expiresAt !== SESSION_NEVER_EXPIRES_AT) bounds.push(Math.max(0, record.expiresAt - now));
    if (bounds.length === 0) return SESSION_FALLBACK_COOKIE_LIFETIME_MS;
    return Math.max(1000, Math.min(...bounds));
  }

  /** Persist the browser-cookie lifetime this record should carry, in seconds. */
  cookieLifetimeSeconds(record, now = this.#now()) {
    if (record.expiresAt <= now) return 0;
    // Rounded up: a lifetime measured a few milliseconds after it was granted
    // must not advertise one second less than the window it stands for.
    return Math.max(1, Math.ceil(this.#advertisedLifetimeMs(record, now) / 1000));
  }

  /** Whether the browser cookie is due to be re-issued so it outlives the session. */
  cookieRenewalDue(record, now = this.#now()) {
    if (record.expiresAt <= now) return false;
    return now - record.renewedAt >= Math.floor(this.#advertisedLifetimeMs(record, now) / SESSION_COOKIE_RENEW_DIVISOR);
  }

  /** Record that the browser cookie was re-issued with a fresh lifetime. */
  markCookieRenewed(record, now = this.#now()) {
    record.renewedAt = now;
    this.persist();
  }

  /** Atomically persist records with owner-only permissions. */
  persist() {
    const temporary = `${this.#file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify({ version: SESSION_STORE_VERSION, sessions: [...this.records.values()] })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#file);
      chmodSync(this.#file, 0o600);
      this.#lastPersistAt = this.#now();
      return true;
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best-effort cleanup after an interrupted atomic write.
      }
      this.#logger?.warn?.("auth-webserver: persistent session store could not be written: %s", error);
      return false;
    }
  }

  #expired(record, now) {
    return record.expiresAt <= now;
  }

  prune(now = this.#now()) {
    let changed = false;
    for (const [id, record] of this.records) {
      if (!this.#expired(record, now)) continue;
      this.records.delete(id);
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  create({ username, address, userAgent, secure = false, authEpoch = 0 } = {}) {
    const now = this.#now();
    let id;
    do {
      id = randomBytes(16).toString("base64url");
    } while (this.records.has(id));
    const record = {
      id,
      authEpoch: Number.isSafeInteger(authEpoch) && authEpoch >= 0 ? authEpoch : 0,
      username: typeof username === "string" ? username.slice(0, 256) : "admin",
      issuedAt: now,
      lastSeenAt: now,
      expiresAt: this.#deadline(now, now),
      renewedAt: now,
      address: typeof address === "string" ? address.slice(0, 128) : "unknown",
      userAgent: sanitizeUserAgent(userAgent),
      secure: secure === true,
    };
    this.records.set(id, record);
    this.persist();
    return record;
  }

  /** Touch one session and return it, or null when it is expired/revoked. */
  touch(id, issuedAt) {
    const now = this.#now();
    const record = this.records.get(id);
    if (record === undefined || record.issuedAt !== issuedAt || this.#expired(record, now)) {
      if (record !== undefined) {
        this.records.delete(id);
        this.persist();
      }
      return null;
    }
    record.lastSeenAt = now;
    record.expiresAt = this.#deadline(record.issuedAt, now);
    if (now - this.#lastPersistAt >= SESSION_PERSIST_INTERVAL_MS) this.persist();
    return record;
  }

  revoke(id) {
    const existed = this.records.delete(id);
    if (existed) this.persist();
    return existed;
  }

  revokeAll() {
    this.records.clear();
    return this.persist();
  }

  list(currentId) {
    this.prune();
    return [...this.records.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.issuedAt - left.issuedAt)
      .map((record) => publicSession(record, currentId));
  }
}

export { normalizeSessionRecord, sanitizeUserAgent };
