# DSH Compatibility

This repository targets the DSH Web bundle, not only the `@deepseek-ai/dsh` CLI
package. Compatibility must be checked against the exact DSH packages that each
plugin injects and the Cordis services/Slots used by its Host and Client halves.

## Version matrix

| DSH line | npm channel | Evidence and status |
| --- | --- | --- |
| `0.1.5-rc.2` | `latest` | Installed locally; this is the current test baseline. The changed plugin suites are run against this line's available dependencies. |
| `0.1.5-rc.3` | `next` | A fresh Node 24 Docker container installed the exact DSH release and all three plugins. The browser exercised the legacy Plugins/Settings Provider and Models UI, saved an Auth lifetime and Web Daemon unit change, and completed a local fake-Responses model turn. The generated unit was inspected; live systemd was not run. |
| `0.1.6-alpha.2` | historical | Existing peer windows are retained where applicable, including the legacy preset package. This line was not revalidated as a complete Web profile in this pass. |
| `0.1.7-alpha.1` | historical alpha | Unsupported. Updated plugin peer windows reject this version. |
| `0.1.7-alpha.2` | `alpha` | A fresh Node 24 Docker container installed the exact DSH release and all three plugins. Container browser/runtime checks passed for Auth SettingsForms migration and the `./` core redirect, the actual Models UI and save path, Web Daemon unit generation, preset/Subagent settings, exact-route allow/deny, and child route/effort cold-resume. The model endpoint was a local fake; systemd and external providers were not exercised. |

The current npm tags resolve to `latest=0.1.5-rc.2`, `next=0.1.5-rc.3`, and
`alpha=0.1.7-alpha.2`. Peer ranges admit `0.1.5-rc.2` and `0.1.5-rc.3`, retain
the historical `0.1.6-alpha.2` line where declared, and admit `0.1.7-alpha.2`
without admitting `0.1.7-alpha.1`.

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
