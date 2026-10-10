# DSH Compatibility

This repository targets the DSH Web bundle, not only the `@deepseek-ai/dsh` CLI
package. Compatibility must be checked against the exact DSH packages that each
plugin injects and the Cordis services/Slots used by its Host and Client halves.

## Unified Package

The workspace root defines `@yiln-dsh/dsh-plugins@0.1.2` (published to npm as
public, under the `latest` tag), with eight internal Host modules and one
composed Client entry. Its current peer
window is `>=0.2.0-rc.2 <0.2.0-rc.3`; the older standalone package windows below
are historical, not a certification of the new suite. The 0.1.1 baseline root
contract and migration suite passed 271 tests; its packed-install evidence is
retained below. The current 0.1.2 suite passed 364 tests; the added Work Journal
and Mentor serial-queue scope is recorded below.

### 0.1.2 — Work Journal and serial Mentor consultations (2026-10-10)

- Adds the `dsh-work-journal` Host row and one Client contribution. It reads the
  existing `sessionPersistence` service and adds no package dependency or peer.
  The index is derived, profile/offset-scoped data under `$DSH_HOME`; all three
  consumers (model tool, `/journal` command and right-sidebar panel) share one
  runtime. Partial scans are labelled rather than presented as complete reports.
- Mentor consultations for each primary Session now queue FIFO. Live work holds
  the queue only until success, failure, cancellation or timeout; historical
  unresolved/undelivered journal outcomes do not permanently block later calls.
  Reset uses the same queue as a barrier. Replaying the same host call only
  recovers an existing complete reply and never silently re-dispatches an
  indeterminate request.
- Compatibility assumptions, privacy boundaries, persistence revision semantics,
  fork-inherited event cuts and failed-delivery behavior are documented in
  [Work Journal](docs/modules/work-journal.md) and [Mentor](docs/modules/mentor.md).
- Verification: root `npm test` passed 364/364; `npm run build` and
  `npm run check` passed. The Mentor isolated deployment evidence and limitations
  are recorded in [its verification report](docs/verifications/mentor-serial-20261009.md).
  A packed `0.1.2` artifact was installed in a separate `DSH_HOME` profile;
  `dsh plugin add` exited successfully and `--dump-config` contained the Work Journal
  row and package address. The installer warned that the required peer packages
  were not present in that profile's pnpm project. This verifies tarball
  installation and Cordis composition, not Host peer resolution or a full Web
  runtime boot. The live profile was not changed.
- The repository's doc-driven-development skill source was also improved and
  self-checked (612/612); it remains Git source material and is intentionally not
  included in the plugin npm tarball.

### 0.1.1 — Agent Teams under delegate-writes

`0.1.0` offered the whole `delegate-writes` design but omitted the Agent Teams
coordination tools from its audited allowlist, so a restricted main agent could
not call `spawn_teammate`, `wait_agent`, or `team_task_*` even though the Team
bundle was installed. The denial text compounded the mistake by advising the main
agent to "delegate this operation to a subagent", which cannot work: the Team
tool plugin installs its tools only into a resolved Team member's scope, and a
plain continuable subagent resolves to no membership. Teammate creation is a
Lead-only operation with no delegated route, so the tools must be callable by the
restricted main agent itself.

`0.1.1` fixes both halves:

- All nine Team tools (`spawn_teammate`, `send_message`, `list_agents`,
  `wait_agent`, `interrupt_agent`, `team_task_create/list/get/update`) are on the
  audited allowlist. They mutate Team state only, never the workspace or runtime.
- The mode-entry check accepts `spawn_teammate` alongside `subagent` and
  `subagent_fork`, so a Team-only composition can enter the mode at all.

It also replaces execution-only refusal with real catalog pruning. The runtime
installs a per-agent `tools.restrict({ allow })` whose allow list is the audited
names intersected with the surface that agent actually inherits. `restrict()`
masks the inherited surface and deliberately exempts the agent's own layer, which
is where the Team plugin registers; intersecting keeps those visible and avoids
the `unknown global tool` rejection that naming them directly would raise. Being
an allow list, a tool registered after this audit stays hidden until deliberately
added. Workers are unaffected because a child's scope chains to the mounted
preset generation scope rather than to the delegating agent.

Behaviour change: the restricted main agent no longer sees withheld schemas at
all. The execution guard remains behind the pruning, so a stale catalog, a
replayed call, or a call via another presentation surface is still refused before
its body runs. Pruning is a visibility boundary, not authorization.

Evidence: [session-mode verification](docs/verifications/session-mode-0.1.1.md).
Unit and integration coverage includes the real
`@deepseek-ai/dsh-experimental-tool-agent-team` plugin, which is what pins the
own-layer registration route.

## Session Mode

The `session-mode` Host row targets the suite's DSH `0.2.0-rc.2` window.
It uses public `tools.guard`, `tools.restrict`, `systemPrompt.assemble` for
model-callable tool checks, dynamic `systemPrompt.section`,
`agent/created`, user commands, the authenticated Connection Fetch registry,
Session Controller cold inspection/resume, and the Job registry. Restricted
main agents require a directly callable delegation surface: native `subagent` or
`subagent_fork`, or Agent Teams' `spawn_teammate`. PTC-only presentation is
rejected rather than admitting arbitrary `run_code`. Independent system sections
preserve the Harness's other instructions. Policies use atomic private sidecars,
not unknown Session event types that this version would refuse on reopen.
This is workflow enforcement and never widens sandbox, planning, or approval
permissions. New-module verification is recorded separately from the preceding
suite migration evidence.

## Historical Version Matrix (2026-09-30)

| DSH line | npm channel | Evidence and status |
| --- | --- | --- |
| `0.2.0-rc.2` | `latest` / `next` | All six workspace plugins loaded in a fresh Node 24 Docker profile. Browser smoke covered Auth login and settings, Web Daemon/Mentor settings, Git Graph repository reads, metrics, the guarded Delete Session endpoint, and mobile width. Production `web` was then upgraded using an independent backup/rollback transaction; the operator chose to uninstall `dsh-loopx-plugin@0.1.1-beta.5` because its DSH peers reject 0.2. The original `127.0.0.1:3080` GUI passed login, plugin inventory, Settings/Mentor catalog, and refresh checks. No live model request or in-GUI systemd action was exercised. |
| `0.1.7-rc.2` | historical | Fresh Node 24 Docker profile with all six workspace plugins; browser login, installed plugin inventory, Auth/Web Daemon/Mentor settings, Git Graph log and commit details, status metrics, and the guarded Delete Session endpoint were exercised. Auth default Host matching was fixed after the first isolated probe returned 421. The production `web` profile then upgraded with a complete pre-cutover backup; its original `127.0.0.1:3080` GUI passed a browser refresh, plugin inventory, and settings smoke check. No live model request or in-GUI systemd control was exercised. |
| `0.1.7-rc.1` | historical | Previous host baseline, retained in the cutover backup; existing package tests passed against this line. |
| `0.2.0-rc.1` | historical | Not admitted by the new peer windows or tested in this pass. |
| `0.1.7-alpha.2` | `alpha` | Previously tested in a fresh container for Auth SettingsForms, Models, Web Daemon unit generation and subagent route recovery (see earlier evidence below). |
| `0.1.5-rc.2` / `0.1.5-rc.3` | historical | Earlier validation described below; preserved where each plugin declares the older peer window. |
| `0.1.7-alpha.1` | historical | Unsupported. |

Five workspace plugin packages declare both `>=0.1.7-rc.1 <0.1.7-rc.3` and `>=0.2.0-rc.2 <0.2.0-rc.3` for their DSH peers; `session-list-cache` declares no DSH peer and loaded in both isolated profiles. These exact prerelease windows do not grant future RCs automatically. The candidate package versions have not been published to npm. The old LoopX package remains only inside the pre-cutover backup; the active profile has no LoopX dependency or bundle.

## Compatibility seams

- The `0.1.5` RC Settings service exposes namespace registration. Auth Webserver
  and Web Daemon retain that branch. DSH `0.1.7-alpha.2` exposes
  profile-level `SettingsForms` (`configure`, `describe`, `update`, `replace`,
  and `mutate`); the adapters configure the current profile row and mark editable
  Config fields `.volatile()` so edits do not remount the plugin.
- Auth Webserver resolves the active profile entry ID for SettingsForms updates.
  Credential changes revoke sessions; lifetime edits update the live session
  store without revoking sessions. Legacy `state.json` migration is blocked only
  by an actual username/password in the user layer. The Host reads the raw
  Settings descriptor only to identify that layer; it returns only booleans and
  never exposes or logs the descriptor. Redacted secret sidecars describe
  effective values, so an empty default password can still be marked `set`.
- The Auth core-session bridge accepts the clean-root process-token redirects used
  by these releases: `/` on RC.3 and `./` on alpha.2. It still rejects any other
  status, location, or cookie shape.
- Web Daemon observes `loader/volatile-update` and reapplies the live row config.
  Its SettingsForms save path updates the generated systemd unit; the regression
  test exercises this with a fake `systemctl` executable and a temporary user
  unit directory.
- The Plugins settings card slot changed from `settings.plugin.item` to
  `settings.plugins.tab` in the `0.1.7` alpha line. Auth Webserver and Web Daemon
  choose the new tab when the Client exposes `configForms`, while retaining the
  RC slots.
- The `0.1.7-alpha.2` Models bundle recognizes only `llm-pi-ai` as the pi-ai
  layout, while this fork uses row ID `llm-pi-ai-adapter`. The patch maps that row
  to the pi-ai layout and rewrites its settings namespace. The actual alpha.2
  Models bundle and the exact `0.1.5-rc.3` Models bundle both passed patch/syntax
  smoke checks. Bundle parsing is not a browser render test.
- Alpha.2 preset composition uses `dsh-agent-preset` and
  `dsh-agent-preset-registry`. The Web Daemon peer metadata also retains the
  legacy `dsh-agent-presets@0.1.6-alpha.2` package and accepts the new optional
  `dsh-agent-preset-registry@0.1.7-alpha.2` package; the service provider peer is
  the registry. The alpha.2 registry still publishes `agentPresets` with
  `mount`, `remoteExportList`, and `select`, which matches the recovery calls.
  The plugin row still requires that service for activation; an optional peer
  declaration does not make the Host service optional.
- `dsh-llm` alpha removed `offloadRequestImagesWithPolicy`. The adapter keeps the
  RC function when present and uses a local image-prefix fallback on alpha,
  including nested tool-result images and deterministic placeholders. This does
  not claim to reproduce alpha's durable `offloaded` marks and
  `IMAGE_OFFLOAD_REQUIRED` retry protocol.
- The Browser Host WebSocket upgrade path declares its URL variable. Git Graph,
  Browser, and Voice Input declare the client/Host capabilities they consume.

## Subagent route policy

`modelSelectionSettings: true` samples the Host's `subagent-model-selection`
preference when a fresh top-level Session is composed. The resulting non-empty
exact provider/model allowlist (`allowedModels`) is durable Session policy and is
inherited by child Sessions. Later preference edits do not rewrite an existing
Session's policy. Add a route before creating/recomposing the Session that should
use it; creating a new model in the Models page does not grant that route to an
already-composed Session. Existing Sessions must be recreated or recomposed to
capture a changed allowlist.

`list_subagent_models` is scoped to the Session's allowed routes. Calls that
select a route supply `provider` and `model` together; `reasoning_effort` is
optional, and changing routes without an explicit effort clears the inherited
route-owned effort. This mode requires an `agentOptions`-capable backend.
A separate isolated `0.1.7-alpha.2` profile showed that an older Session keeps
its prior allowlist after a Settings save while a new Session captures the
expanded route list. A fresh alpha.2 Docker container then exercised a local
fake OpenAI Responses endpoint: the real `subagent` Tool rejected an unlisted
model, while an authorized child ran on `smoke-route/smoke-child-model` at `high`
effort. The worker's `active-sessions.json` recorded the child, and after a worker
restart the recovery diagnostics reported `resumed-parent` and `resumed-child`;
the fake endpoint observed the restored child request with the same model and
effort.

## Evidence from this pass

- A local `dsh-plugin-compat:local` Docker image was built from `node:24-bookworm` and installed exact `@deepseek-ai/dsh@0.1.7-alpha.2` and `@deepseek-ai/dsh@0.1.5-rc.3` packages into separate prefixes. Fresh containers installed Auth Webserver `0.10.2`, LLM Adapter `0.6.1`, and Web Daemon `0.8.1` via `dsh plugin --profile web add file:/plugins/...`; the three source directories were mounted read-only. DSH stayed bound to container loopback; browser access used a TCP forwarder published only on host `127.0.0.1` because the DSH CLI deliberately rejects `--host 0.0.0.0`.
- Alpha.2 container: the Auth card imported a mode-`0600` legacy `state.json` even though the profile already overrode realm and idle lifetime. The UI showed the migrated username, password configured, and idle `600`; the Auth gateway served DSH to valid fake Basic credentials and returned its login form for an invalid password. The test caught two compatibility details: `SettingsForms` redacted secret metadata reflects effective defaults, so migration now inspects the raw Host-local `user` layer without returning it; the core process-token exchange accepts the exact `./` root redirect used by alpha.2 (and `/` used by RC.3).
- Alpha.2 container: Models UI displayed `smoke-route`, its two models, service tier and reasoning controls; saving Priority persisted to the profile. Web Daemon SettingsForms saved port `39285`; the generated user unit contained `ExecStart=... --port 39285`. The container uses a `systemctl` shim, so this verifies unit generation/refresh rather than a live systemd manager.
- Alpha.2 container: the Subagent page authorized exact `smoke-route/smoke-model` and `smoke-route/smoke-child-model` pairs. Trajectory showed `smoke-route/unlisted-model` rejected. An allowed continuable child ran on `smoke-child-model` at `high` effort; `active-sessions.json` stored its lineage. After stopping and restarting the Web Daemon worker, `recovery-diagnostics.json` reported `resumed-parent` and `resumed-child`, and the local fake Responses endpoint received the resumed child request with the same model and effort. Session logs contained the exact Session policy and child descriptor.
- RC.3 container: the legacy Plugins Settings page rendered Auth Webserver and Web Daemon forms; valid/invalid Basic auth behaved as expected. The Auth lifetime Save persisted `660` seconds. The legacy Models patcher displayed per-model capacities, service tier, and reasoning effort; saving Priority persisted through the legacy Settings Provider. A local fake Responses turn completed. Web Daemon Save generated a unit with `--port 39286`.
- Both containers used a local fake OpenAI Responses endpoint; no external model provider or production credential was contacted. The Docker npm install warned that lifecycle scripts for `dsh-subprocess-local`, `node-pty`, `koffi`, `protobufjs`, and `@google/genai` were not approved, so shell/PTY helper execution was not part of this smoke.
- Final package test runs passed **174/174 tests**: Auth Webserver 104, Web Daemon 31, LLM Adapter 19, Delete Session 15, LoopX View 4, and Web Browser 1. `node --check` passed for all 15 changed JavaScript files; `git diff --check` passed. The container `dsh plugin add` operations validated each target profile's package manifests and peer resolution.
- TDD regressions were verified: the Auth migration test was RED when a redacted effective-secret sidecar falsely treated an empty default password as a user override, then GREEN with the raw Host-local user layer. The alpha.2 `./` redirect regression was RED before the bridge accepted both clean-root forms, then `node --test test/core-session.test.js` passed 6/6.

## Remaining release checks

- A real systemd user manager was not available in the containers. Unit rendering and save/refresh were tested with a `systemctl` shim; actual enable/start/restart behavior remains unverified.
- No live DeepSeek or third-party API credentials were used. The LLM integration exercised local OpenAI Responses fixtures, not provider billing, availability, or provider-specific behavior beyond the configured route contract.
- Dependency lifecycle scripts were blocked by npm's container install policy. The exercised Web, Settings, local model, subagent, and worker-recovery paths passed, but terminal/PTY execution and the subprocess helper are not certified here.
- The full DSH 0.1.6-alpha.2 Web profile was not started; that historical peer window remains metadata-only. DSH 0.1.7-alpha.1 remains unsupported by design.

The container smoke verifies the three listed plugins on exact RC.3 and alpha.2 Web profiles for the behaviors above. It is not a blanket certification of every DSH capability, operating-system service manager, historical version, or external model provider.
