import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply, liveConfig, profileEntryId } from "../index.js";

function volatile(value) {
  let current = value;
  return {
    get() { return current; },
    set(next) { current = next; },
  };
}

test("liveConfig reads alpha volatile values and falls back to defaults", () => {
  const profile = volatile("web");
  const config = liveConfig({ profile }, { profile: "other", enabled: false });
  assert.deepEqual({ profile: config.profile, enabled: config.enabled }, { profile: "web", enabled: false });
  profile.set("desktop");
  assert.equal(config.profile, "desktop");
});

test("profileEntryId reads the current loader entry and falls back on rc", () => {
  assert.equal(profileEntryId({ fiber: { entry: { options: { id: "webserver-auth" } } } }, "fallback"), "webserver-auth");
  assert.equal(profileEntryId({ get: () => undefined }, "webserver-auth"), "webserver-auth");
});

test("profile legacy migration ignores unrelated user-layer overrides", async () => {
  async function runMigration(user, secretSet = true) {
    const home = mkdtempSync(join(tmpdir(), "dsh-auth-profile-config-"));
    const previousHome = process.env.DSH_HOME;
    const entryId = "alpha-auth-row";
    const stateDirectory = join(home, "plugins", "dsh-plugin-auth-webserver");
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, "state.json"), JSON.stringify({
      username: "legacy-admin",
      password: "legacy-secret",
      realm: "Legacy gateway",
    }), { mode: 0o600 });
    process.env.DSH_HOME = home;

    const updateCalls = [];
    const disposers = [];
    let profileRowActive = false;
    const settings = {
      writable: true,
      configure() {
        setImmediate(() => { profileRowActive = true; });
        return () => {};
      },
      describe(options) {
        if (!profileRowActive) return [];
        if (options?.redactSecrets !== true) return [{ ns: entryId, revision: 7, user }];
        const redactedUser = { ...user };
        delete redactedUser.password;
        return [{
          ns: entryId,
          revision: 7,
          user: redactedUser,
          secrets: [{ path: ["password"], set: secretSet }],
        }];
      },
      async update(ns, patch, revision) { updateCalls.push({ ns, patch, revision }); },
    };
    const ctx = {
      fiber: { entry: { options: { id: entryId } } },
      connection: { authenticatedUrl: (url) => `${url}/?token=unused` },
      logger: { warn() {}, info() {} },
      get(name) { return name === "settings" ? settings : undefined; },
      on() { return () => {}; },
      effect(factory) {
        const disposer = factory();
        if (typeof disposer === "function") disposers.push(disposer);
        return disposer;
      },
    };

    try {
      await apply(ctx, { port: 0, addresses: ["127.0.0.1"] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return updateCalls;
    } finally {
      for (const dispose of disposers.reverse()) await dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }

  assert.deepEqual(await runMigration({ sessionIdleTimeoutSeconds: 900 }), [{
    ns: "alpha-auth-row",
    patch: { username: "legacy-admin", password: "legacy-secret", realm: "Legacy gateway" },
    revision: 7,
  }]);
  assert.deepEqual(await runMigration({ username: "configured-admin" }), []);
  assert.deepEqual(await runMigration({ password: "configured-secret" }), []);
});
