# Session Mode 0.1.1 Verification

Covers the `0.1.1` change to the `session-mode` Host row: admitting Agent Teams
into the `delegate-writes` allowlist and replacing execution-only refusal with
real catalog pruning.

## Defect And Fix

In `0.1.0` the `delegate-writes` allowlist omitted every Agent Teams tool except
`send_message`, `interrupt_agent` and `list_agents`. A restricted main agent
therefore could not call `spawn_teammate`, `wait_agent` or `team_task_*`, and the
denial advised delegating the call to a subagent — which cannot work, because
`TeamRoster.tryMembership` returns no membership for a session carrying a
subagent descriptor, so the Team tool plugin never installs those tools into a
plain subagent's scope. Teammate creation is a Lead-only operation.

The mode-entry check had the same blind spot: it accepted only `subagent` and
`subagent_fork`, so a composition offering only the Team surface was rejected with
`unsupported`.

## Changes

- `DEFAULT_ALLOWED_TOOLS` gains `spawn_teammate`, `wait_agent` and the four
  `team_task_*` tools; all nine Team tools are now callable by a restricted Lead.
- The entry check accepts any one of `subagent`, `subagent_fork`,
  `spawn_teammate`.
- A per-agent `tools.restrict({ allow })` prunes the unaudited tools out of the
  restricted main agent's model-facing catalog. The allow list is the audited
  names intersected with the surface that agent actually inherits.
- The prompt text no longer claims the full catalog stays visible; withheld tools
  are described as absent and refused.

## Two Registration Facts The Fix Depends On

Both were established by direct experiment, because the fix is incorrect if either
is false.

1. **`restrict()` exempts the agent's own layer.** The Team plugin registers via
   `agent.ctx.tools.register`, so its tools live in the agent's own layer, which
   `restrict()` deliberately does not mask. Naming them in the allow list would
   raise `unknown global tool` when the scope does not inherit them, and be
   pointless when it does. Hence the intersection with the inherited surface.
   Because the filter is an allow list, a tool registered after this audit stays
   hidden until deliberately added — the fail-closed direction, confirmed by
   registering a new inherited tool after pruning and observing it stay invisible.

2. **A worker's scope chains to the preset generation scope, not to the
   delegating agent.** `agent-preset-registry`'s `join` calls
   `bindScopeParent(key, generation.key)`. Restricting one main agent therefore
   cannot leak into its children. A probe that parented a child scope to the
   parent agent produced the opposite result and would have blinded every worker;
   the production topology is the sibling form.

## Test Evidence

- `npm run build`, `npm run check`, `npm test`: **271 passed, 0 failed** (up from
  266 at `0.1.0`).
- New `src/session-mode/test/agent-team.test.js` installs the **real**
  `@deepseek-ai/dsh-experimental-tool-agent-team` plugin, whose `install` path
  registers through `agent.ctx`. The earlier fixtures registered Team tools on the
  preset layer and so never exercised the own-layer route. The test asserts a
  restricted Lead's `spawn_teammate` reaches the tool body, the wider Team surface
  stays callable, withheld tools leave the catalog and are refused, and a control
  fixture under `normal` mode denies nothing. The real plugin is an experimental
  transitive dependency, so the file skips rather than fails where it is absent.
- Mutation checks: removing the Team tools from the allowlist fails the new test;
  removing the pruning fails it; replacing the inherited-surface intersection with
  the raw allow list fails it. All three were confirmed and reverted.
- The integration test asserts both halves on real Cordis scopes: the pruned
  catalog, the own-layer Team tools surviving, and the catalog restored on
  returning to `normal`.

## Live End-To-End Run

An isolated DSH instance was booted on port 3097 with its own `DSH_HOME`
(`/root/.dsh-mode-qa`), the suite installed from the workspace by `file:`, the
real `@deepseek-ai/dsh-experimental-agent-team-profile` bundle, and the real
configured model route. Production 3080 was not touched.

A prompt requiring a teammate was sent to the real model while the session was in
`delegate-writes`. Recorded results:

- `spawn_teammate` returned `isError: false` with
  `{"target":"probe-1","role":"teammate","status":"running",...,"model":"gpt-6-luna"}`.
- The Lead's log contains `team/member` for `probe-1` reaching
  `phase: "active"`, written by the real roster — not just a model claim.
- A real child session was created carrying `subagent/descriptor` with
  `label: "qa probe"`, and it returned its reply.
- The same session's model-facing catalog held 25 tools: `bash`, `edit`, `write`,
  `workflow` and `ralph` pruned; all nine Team tools visible.
- Zero `cannot call` refusals were recorded in that session.

The isolated `DSH_HOME`, including its session logs, is retained for inspection.
The credentials copy made for that instance was shredded after the run.

## Boundaries And Limits

Pruning is a visibility boundary, not authorization or OS isolation. The
monotonic execution guard remains behind it for stale catalogs, replayed calls and
alternative presentation surfaces. Writable workers still share the workspace and
filesystem. The plugin never widens sandbox, planning or approval permissions.

Not exercised in this pass: the browser mode journeys
(`npm run test:modes:browser`), which require an isolated fixture profile; and a
packed-tarball install of `0.1.1`, which the release workflow runs separately.
