import assert from "node:assert/strict";
import test from "node:test";
import { requireLiveBrowserSession } from "../index.js";

test("requires a non-empty live session for browser control", () => {
  const agents = { get: (id) => id === "session-1" ? { id } : undefined };
  assert.equal(requireLiveBrowserSession(agents, " session-1 "), "session-1");
  assert.throws(() => requireLiveBrowserSession(agents, ""), /sessionId is required/u);
  assert.throws(() => requireLiveBrowserSession(agents, "session-2"), /session is no longer live/u);
});
