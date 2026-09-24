# Plugin E2E Matrix

## Scope and Target

This report records the isolated DSH `0.1.7-alpha.2` baseline run and the compatibility target selected afterward. The next target is `@deepseek-ai/dsh@0.1.7-rc.1` (`next` tag); npm currently reports `latest=0.1.5-rc.3` and `alpha=0.1.7-alpha.2`.

The baseline exercised every repository plugin plus the local LoopX companion. No production model credentials or external LoopX service were used. All workspaces, model responses, Auth state, audio, and browser pages were synthetic.

## Alpha.2 Environment

- Remote host: `192.168.44.84`, accessed through the authorized Server Agent mTLS client.
- Test container: `dsh-plugin-e2e-all-alpha2`; DSH `0.1.7-alpha.2`; DSH Core stayed on container loopback `127.0.0.1:39286`.
- Auth Gateway was the only published DSH port (`192.168.44.84:45881`). A temporary local-only `127.0.0.1:45883` TCP tunnel provided a secure browser origin for microphone APIs; the profile explicitly allowed that origin.
- Synthetic OpenAI Responses endpoint: container `127.0.0.1:39290`; Browser fixture: `127.0.0.1:49300`; workspaces: `/home/node/e2e-workspaces`.
- The remote npm registry request failed certificate verification. TLS validation was not disabled; the exact Alpha.2 profile was installed in a clean local DSH container and transferred to the isolated remote container.
- The container's `systemctl` is an exit-zero shim. Unit rendering and settings persistence were testable; a real systemd user manager was not available.

## Results

| Plugin | Case | Status | Evidence |
| --- | --- | --- | --- |
| Auth Webserver | Legacy migration, valid login, lifetime update | PASS | The mode-`0600` legacy Auth state migrated into the profile user layer, remained available after a DSH restart, and the synthetic account logged in. SettingsForms saved idle lifetime `660` seconds. The legacy file was retained as backup. |
| Delete Session | Cancel and permanently delete one synthetic session | PARTIAL | Cancel preserved the row. Permanent delete removed the row and it stayed absent after refresh, but the confirmation dialog remained disabled on `Deleting…` for at least 20 seconds. |
| File Message | Send Markdown and PNG; preview and download | PARTIAL | Markdown card and preview rendered; Download action was present. The PNG card and Download original action appeared; the same-origin preview endpoint returned HTTP 200, `image/png`, 5,757 bytes, and a valid PNG signature, but the UI image remained `naturalWidth=0` and did not decode. |
| Git Graph | Branches, tag, status, and commit diff | PASS | `main` and `feature/e2e`, two commits, `v0.1-e2e`, one uncommitted change, and the `src/app.js` diff were visible. |
| LLM Adapter | Custom model route and Settings Models | PASS | A fresh Smoke Model turn returned `local model smoke complete`. Through the secure localhost origin, Settings > Models listed `smoke-route` and its models. The earlier remote-IP origin failure did not reproduce through the allowed localhost origin. |
| LoopX View | Unbound companion behavior | PARTIAL | The local companion CLI was reachable, but no LoopX binding existed. The unbound page/chat remained fail-closed. A positive bound-service flow was not tested. |
| Mentor | Isolated Mentor consultation and parent reply | FAIL | The fake Responses endpoint issued the `mentor` tool call and answered the child request with no tools, but the plugin returned `MENTOR_INCOMPLETE: no committed final reply was produced`; the parent only received the fallback model text. Adding the standard `response.output_text.done` SSE event did not resolve it. |
| Session List Cache | Duplicate suppression and list invalidation | PASS | Two uniquely named Smoke Model sessions appeared once each. Deleting only the second removed that row while preserving the first. No cache-hit or performance claim is made. |
| Terminal Tab | Sandboxed terminal session | BLOCKED | The Alpha.2 container had no sandbox provider; the feature returned `SANDBOX_UNAVAILABLE`. The DSH process exited during the same test interval. Sandbox policy was not bypassed. RC.1 provides a native Terminal sidebar, so the repository Terminal Tab is not being migrated. |
| Voice Input | Synthetic 16 kHz speech, partial and final draft | PASS | On the secure localhost origin, a per-call synthetic PCM stream reached the UI. A partial appeared, offline correction inserted `The remote might working.`, and the button returned to idle. The eSpeak wording was not transcribed verbatim. |
| Web Browser | Server-side Chromium local fixture | PASS | Chromium opened the local fixture, showed title `E2E Browser Fixture` and heading `Remote browser fixture`, then changed the visible button result to `clicked`. |
| Web Daemon | Unit save and worker recovery | PARTIAL | SettingsForms saved port `39286`; the generated user unit contained `--port 39286`. With `DSH_WEB_DAEMON_WORKER=1` and a running synthetic child, no `active-sessions.json` or recovery diagnostics were written, and the fake endpoint observed no resumed child request after a worker restart. Real systemd was unavailable. |
| LoopX companion | CLI and unbound state | PARTIAL | The synthetic CLI version command worked. No real binding or external LoopX service was configured. |

## RC.1 Overlap Policy

The target is `@deepseek-ai/dsh@0.1.7-rc.1`. Use native functionality where it fully replaces a repository feature; otherwise preserve the repository-owned behavior that remains distinct.

| Repository plugin | RC.1 overlap | Decision for this adaptation |
| --- | --- | --- |
| Terminal Tab | `dsh-terminal`, `dsh-api-terminal-controller`, and `dsh-client-ui-sidebar-terminal` provide interactive shell tabs and recovery. | Retired: repository package removed; use the native Terminal. |
| Voice Input | `dsh-experimental-voice-input-bundle` records then transcribes but does not provide streaming partial captions. | Retired: repository package removed on user decision; use the native Voice Input bundle. |
| Web Browser | Native Browser is a sandboxed iframe and disabled by default in Web; it does not provide the repository's DSH-host Chromium/intranet behavior. | Retired: repository package removed on user decision. |
| File Message | Native file references, attachments, and deliverables overlap presentation, but not the repository's `send_file`/`send_image` workspace-backed tool behavior. | Retired: repository package removed on user decision; native `present` plus the deliverables cards cover the user-visible need. |
| LLM Adapter | Native `dsh-llm-pi-ai` and Models UI now cover provider routing, per-model `reasoningEfforts`, per-profile `timeoutMs`, a stream idle watchdog, and image bounding. | Retired: repository package removed on user decision. The fork's remaining unique behavior (`serviceTier`, tool-argument filler cleanup, total-stream wall-clock deadline) is dropped with it. |
| Session List Cache | Native session projection cache checkpoints projections, not concurrent `listSessions()` scans. | Keep and adapt the list cache. |
| Auth Webserver | Native Web auth/authorization does not replace the repository LAN gateway, TOTP/Passkeys, Host/Origin policy, and revocable sessions. | Keep and adapt the LAN gateway. |
| Web Daemon | Native persistence and agent/subagent APIs are recovery substrate, not systemd control or host metrics. | Keep and adapt unit management, metrics, and restart recovery. |
| Git Graph | No native Git Graph package was found. | Keep and adapt. |
| LoopX View | Native Goal UI does not bind or project the external LoopX task graph. | Retired: repository package removed on user decision. |
| Mentor | Native Agent/subagent tools are generic; they do not provide the repository's isolated Mentor thread/journal/settings. | Keep and adapt. |
| Delete Session | Native session control/persistence does not expose the repository's confirmed permanent-delete workflow. | Keep and adapt. |

## RC.1 Verification Plan

- Install exact `@deepseek-ai/dsh@0.1.7-rc.1` into a separate profile/container; do not modify `~/.dsh/profiles/web` or shipped presets.
- Add only repository plugins whose custom behavior is still needed. Use DSH's native Terminal instead of `dsh-plugin-terminal-tab`; keep the custom Voice plugin and disable the competing native Voice UI in that test composition.
- Adapt peer package names/ranges from the actual RC.1 bundle manifests; do not treat a peer-range widening as proof of API compatibility.
- For each retained plugin, verify load/slot registration, its feature-specific journey, failure behavior, and persistence where applicable, using local fake providers and synthetic workspaces only.
- Keep the Alpha.2 failures above as baseline findings; record each RC.1 result separately rather than overwriting the baseline.

## RC.1 Environment

- Runtime: exact `@deepseek-ai/dsh@0.1.7-rc.1` in isolated container `dsh-plugin-e2e-all-rc1`; Core stayed on `127.0.0.1:39286`.
- Synthetic Responses endpoint: container `127.0.0.1:39290`; Browser fixture: `127.0.0.1:49300`; workspaces: `/home/node/e2e-workspaces`. The browser used the local Auth tunnel at `http://localhost:45883/` and a synthetic account.
- All prompts, model responses, Auth state, workspaces, images, and repository fixtures were synthetic. No production model credentials or external LoopX service were used.
- The transferred RC.1 profile contained stale `file:` package copies for Mentor. `dsh plugin remove` could not reinstall because of `ERR_PNPM_UNEXPECTED_STORE`; the current Mentor package files were refreshed directly in this disposable profile and the worker restarted. No user profile or shipped preset was modified.

## RC.1 Results

| Plugin | Status | RC.1 evidence and gaps |
| --- | --- | --- |
| Auth Webserver | PARTIAL | The synthetic account logged in. RC.1 SettingsForms saved the idle timeout from 660 to 661 seconds and showed 11m1s in force. Unit suite: 104/104. Passkey/TOTP and legacy-state migration were not repeated in the RC.1 browser run. |
| Delete Session | PASS | Cancel preserved the synthetic session; confirmed deletion removed the selected session from the list. Unit suite: 15/15. |
| File Message | PASS | `send_file` rendered `fixture.md`, its Markdown preview, and Download. In a separate clean Session, `send_image` rendered `fixture.png`, View original, and Download original; the decoded image was complete at 192×192. The tool row is collapsed by default; the first parallel check missed it, and the image mock requires an isolated Session. |
| Git Graph | PASS | The synthetic repository showed branch, tag, status, and commit diff. No standalone unit-test script is provided. |
| LLM Adapter | PASS | RC.1 Models listed `smoke-route` and the custom per-model controls; a synthetic model turn succeeded. Unit suite: 19/19. |
| LoopX View | PARTIAL | The Session's LoopX Conversation tab rendered the expected unbound Goal/Agent empty state. A positive externally bound Goal/Agent projection was not available in the isolated profile. Unit suite: 4/4. |
| Mentor | PASS | `SMOKE_MENTOR` called the isolated tool, returned a canonical reply, and the Mentor history showed Consultation 1 as Delivered with the question, evidence, and answer. Settings displayed the RC.1 ModelCatalog and Profile route. Unit suite: 37/37. |
| Session List Cache | PASS | Duplicate session rows were suppressed and deleting one invalidated only that entry. Unit suite: 18/18. |
| Terminal Tab | NOT RUN (SUPERSEDED) | The repository Terminal Tab was not installed or changed; the RC.1 profile used native Shell instead. |
| Voice Input | PARTIAL | Streaming partial captions appeared and the control returned to idle. The final synthetic transcription was garbled (`The remote might working.`). No standalone unit-test script is provided. |
| Web Browser | PASS | Host-side Chromium opened the local fixture, displayed its title and heading, and changed the button result to `clicked`. Unit suite: 1/1. |
| Web Daemon | PARTIAL | RC.1 cold-restart recovery resumed both the synthetic parent and child; `recovery-diagnostics.json` recorded `resumed-parent` and `resumed-child`, and the fake provider logged one `child-resumed`. Unit suite: 32/32. The container's `systemctl` is an exit-zero shim, so a real systemd user manager was not tested. |
| LoopX companion | PARTIAL | The local synthetic CLI was reachable; no external LoopX service or positive task binding was configured. |

## Mentor TDD Evidence

- Format v4 producer source: RED failed with `format v4 message requires a producer-owned source kind` for the old generic `source.kind: 'plugin'`; GREEN uses the producer ID `dsh-plugin-mentor`. The test harness applies the same format-v4 rejection.
- RC.1 Session history: RED failed with `MENTOR_CONTEXT_VIOLATION` because RC.1 `deriveMessages()` includes the persisted `system/message`; GREEN compares either the complete persisted history or the legacy history after its separate leading system prompt, while retaining message identity, role, route, and content checks.
- Durable reply fallback: RED reproduced `MENTOR_INCOMPLETE` when a complete durable turn had no live assistant-stream frames; GREEN recovers only a complete, correlated, non-interrupted text reply using the existing `extractSettledReply()` checks.
- Shared Connection route: the regression test confirms registration at the exact `/api/mentor.view` path consumed by RC.1 `connection.rpc`; Client history and Settings both returned successfully after the test profile was refreshed.
- Source plan: derived from the user's request to adapt retained plugins to DSH RC.1 and verify their feature paths; no separate plan file was used.
- User journey: the root Agent invokes Mentor; the isolated child records an explicit producer-owned input, completes one no-tool model turn, returns a canonical reply, and exposes the delivered consultation in the Session Mentor view.

| Guarantee | Test | Type | RED/GREEN evidence |
| --- | --- | --- | --- |
| RC.1 format v4 accepts Mentor's producer-owned user source | `mentor.test.js` — `uses a producer-owned user source accepted by RC.1 format v4` | Unit/contract | RED: `format v4 message requires a producer-owned source kind`; GREEN: included in final 37/37 suite. |
| Request validation accepts RC.1's persisted system-message history while preserving the legacy layout | `mentor.test.js` — `matches RC.1 system messages already persisted in Session history` | Unit/integration | RED: `MENTOR_CONTEXT_VIOLATION: request messages differ from the Mentor session history`; GREEN: final 37/37 suite. |
| A complete durable reply is recoverable without live assistant-stream frames | `mentor.test.js` — `recovers a committed reply from durable events when assistant-stream frames are absent` | Unit/integration | RED: `MENTOR_INCOMPLETE: no committed final reply was produced`; GREEN: final 37/37 suite. |
| Mentor's shared Fetch route matches RC.1's exact API path | `mentor.test.js` — `registers Mentor shared Fetch at the full RC.1 /api path` | Unit/contract | RED when the route was registered under the wrong path; GREEN at `/api/mentor.view`, matching the live Client RPC. |
| The complete Mentor tool journey works in the actual RC.1 profile | Browser `SMOKE_MENTOR` E2E | E2E | PASS: tool result delivered; Mentor history shows the question, evidence, and reply. |

- Final command: `npm test` in `dsh-plugin-mentor` passed 37/37. The RC.1 Browser E2E then showed a Delivered history item and the final tool reply.

## Coverage and Gaps

- Available unit suites passed: Auth Webserver 104, Delete Session 15, LLM Adapter 19, LoopX View 4, Mentor 37, Session List Cache 18, Web Browser 1, Web Daemon 32 (230 total).
- File Message, Git Graph, and Voice Input have no `npm test` script or unit-test files; their listed checks are manual synthetic E2E cases.
- No coverage script is defined for Mentor; no percentage is claimed. LoopX positive binding, Voice final transcription quality, full Auth security flows, and real systemd operations remain unverified in RC.1.

## Retired Repository Packages (2026-09-24)

Six repository packages were removed from the working tree on user decision after the RC.1 audit; the Alpha.2 and RC.1 rows above are retained as historical records of runs performed while those packages existed.

| Removed package | Reason |
| --- | --- |
| `dsh-plugin-loopx-view` | Native Goal UI plus the external LoopX bundle cover the surface the user needs. |
| `dsh-plugin-web-browser` | Superseded by the native Browser surface. |
| `dsh-plugin-voice-input` | Superseded by `dsh-experimental-voice-input-bundle`. |
| `dsh-plugin-terminal-tab` | Superseded by `dsh-client-ui-sidebar-terminal` and the native Terminal rows. |
| `dsh-plugin-file-message` | Superseded by the native `present` tool and `ui-deliverables` cards. |
| `dsh-plugin-llm-adapter` | RC.1 `dsh-llm-pi-ai` absorbed per-model reasoning, profile timeouts, idle watchdog, and image bounding. |

Retained packages: Auth Webserver, Delete Session, Git Graph, Mentor, Session List Cache, Web Daemon. Session List Cache stays because RC.1 still re-reads and zstd-decodes every persisted session header on each `listSessions()` with no coalescing or header cache (`dsh-session-query/lib/index.js:95,283`; `dsh-session-persistence-jsonl/lib/index.js:2569,3031,3059`).
