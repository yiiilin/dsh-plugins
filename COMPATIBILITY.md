# DSH Compatibility

This repository targets the DSH Web bundle, not only the `@deepseek-ai/dsh` CLI
package. Compatibility must be checked against the exact DSH packages that each
plugin injects and the Cordis services/Slots used by its Host and Client halves.

## Unified Package

The workspace root defines `@yiln-dsh/dsh-plugins@0.1.3`, with eight internal Host
modules and one composed Client entry. Its current peer window is
`>=0.2.0-rc.2 <0.2.1`; the older standalone package windows below are historical,
not a certification of the new suite. `0.1.3` is the latest published artifact
(npm public, `latest` tag, published 2026-10-13). The 0.1.1 baseline root
contract and migration suite passed 271 tests; its packed-install evidence is
retained below.
The 0.1.2 suite passed 364 tests; the current `0.1.3` suite passes 484 (2 skipped
without a local model cache); the
added Work Journal and Mentor serial-queue scope is recorded below.

### 0.1.3 — DSH `0.2.1` peer window (2026-10-12)

**What changed.** The root version moved to `0.1.3` and all 31 `@deepseek-ai/dsh*`
peer ranges moved from `>=0.2.0-rc.2 <0.2.0-rc.3` to `>=0.2.0-rc.2 <0.2.1`. The
non-DSH peers (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `react`,
`react-dom`) are unchanged.

`0.1.3` also carries two Host behavior fixes and one Client feature:

1. **Web Daemon — cross-install unit write.** A boot-time systemd unit write is now
   refused when the existing unit belongs to a different `DSH_HOME`
   (`src/web-daemon/index.js`, `assertUnitHomeOwner()`), fixing a defect that
   overwrote the host unit during isolated-profile boots.
2. **Work Journal — a web route that was never registered.** `installRoute()` read
   `ctx.get('connection')` while the module declared
   `inject = ['tools', 'commands', 'sessionPersistence']`. With `connection`
   absent, `ctx.get` returned `undefined`, the function returned early, and no
   route existed at all — the panel's `POST /work-journal` answered **405**.
   A second defect sat behind it: the route used `connection.rpc.handle`, which
   resolves through `ctx.webServer` and throws
   `cannot get property "webServer" without inject` from a plugin row. It is now
   `connection.fetch.register({ path: '/api/work-journal' })`, mirroring
   `session-mode`, with the RPC form kept only for a runtime that has no `fetch`.
3. **Work Journal — the range switch blanked the page.** The panel stored
   `{ controller, live }` in a ref but called `.abort()` on the wrapper, so
   choosing another range (今日 after 本周) threw
   `active.current?.abort is not a function`, the `main` slot entry crashed, and
   the page went blank. Cancellation now goes through `cancelActive()`, which
   clears `live` first and aborts `controller`.
4. **Work Journal — the entry moved to the left rail.** The panel is now a
   `sidebar.panellist` button beside 插件 and 自动化任务, below 新建会话, with its
   page in the `main` seat keyed by `work-journal`. The right-sidebar tab and its
   `sidebar.right.pane.tab` body are retained.

5. **Work Journal — scheduled, searchable reports.** The module now generates
   reports on a calendar schedule (yesterday at 00:00 daily, the completed
   Sat–Fri week on Saturdays, the previous month on the 1st), writes each as
   Markdown plus metadata under `<DSH_HOME>/work-journal/`, and indexes them in
   SQLite with an FTS5 trigram table for keyword search and a `vec0` table of
   512-dimension `bge-small-zh-v1.5` embeddings for semantic search. The panel
   became a newest-first report list with spans and a search box. Two new
   dependencies (`sqlite-vec`, `@huggingface/transformers`) are declared;
   scheduled generation is off by default, and both dependencies degrade to
   keyword-only search when absent.

**Deployed and verified on the live profile (2026-10-13).** `schedule: true` with
`maxCatchUp: 3` produced one report of each kind on the first boot — `day/2026-10-12`
(58 sessions), `week/2026-W41` (280) and `month/2026-09` (98) — each written as a
`.md`/`.json` pair and indexed in `index.sqlite`. The panel listed them newest-first
with correct spans, opened a body, and a hybrid search for 递归迭代 returned the
day report first. Two defects were found only by running it:

- **Split data directory.** `apply()` passed the raw `NaN` offset sentinel to the
  reports-directory key while `runtime.js` resolved it to the host offset before
  deriving its own key, so the live index and every report landed under different
  directories. Both now resolve the offset once, in `apply`.
- **Span rendered in UTC.** The panel formatted period boundaries with
  `toISOString()`, so a report whose body read `2026-10-12 00:00:00 ~
  2026-10-12 23:59:59` displayed as `2026-10-11 16:00 ~ 2026-10-12 15:59`. The
  host now sends `tzOffsetMinutes` with every response and the panel renders in
  that zone, falling back to UTC only when an older host omits it.

Installing on this host required a registry mirror (`registry.npmmirror.com`):
`registry.npmjs.org` was unreachable, and pnpm aborted the install with
`ERR_PNPM_META_FETCH_FAIL` before any profile file was touched. `pnpm` also
ignores `onnxruntime-node`'s build script by default, but the published tarball
already carries the native library, so nothing is missing. Note that reinstalling
the *same* version from the *same* tarball path reuses pnpm's cached extraction —
a changed build needs a new tarball path or a cleared lockfile entry.

The inject change is guarded by a new `npm run check` rule: a Loader row must
inject every service its module declares, so the original mismatch can no longer
pass CI. `client.js` necessarily differs from `0.1.2` because Client source
changed; it is regenerated by `npm run build`. No Loader
row ID other than the Work Journal inject list, no HTTP path beyond the added
`/api/work-journal`, no locale/slot ID, Git tab identity, cookie name or
Auth/Daemon state directory changed.

**Why the window had to move.** The DSH installer evaluates every declared peer
with semver `{ includePrerelease: true }` and rejects the install outright when a
peer does not match the running runtime. The old window ends below
`0.2.0-rc.3`, so on the `0.2.1-alpha.2` runtime the plugin could not be installed
at all. The two recorded routes out of that state are below.

**What the new window admits.** Verified with semver `{ includePrerelease: true }`
against the exact range string:

| Version | Admitted by `>=0.2.0-rc.2 <0.2.1` |
| --- | --- |
| `0.2.0-rc.2` (the installed runtime here) | yes — feature-certified |
| `0.2.0-rc.3` | yes — admitted but untested |
| `0.2.0` final | yes — admitted but untested |
| `0.2.1-alpha.1` | yes — admitted but untested |
| `0.2.1-alpha.2` | yes — feature-certified, with the Client caveat below |
| `0.2.1` final | no |
| `0.3.x` | no |

Admitted is not certified. This is an upper bound of `<0.2.1`, not `<0.3.0`, on
purpose: the window will need a fresh compatibility pass and a re-widening at
`0.2.1` final, and the two untested prereleases are admitted for install
convenience, not claimed as working.

**Feature-level status.** Both `0.2.0-rc.2` and `0.2.1-alpha.2` are
feature-certified, per module, with two named caveats that are not rounded away:

| Module | `0.2.1-alpha.2` verdict |
| --- | --- |
| Auth Webserver | WORKS |
| Delete Session | WORKS |
| Git Graph | WORKS |
| Mentor | **WORKS-WITH-CAVEAT** — on `0.2.1-alpha.2` every consultation failed until the runtime-context fix below |
| Session List Cache | WORKS |
| Session Mode | WORKS |
| Work Journal | WORKS |
| Web Daemon | **WORKS-WITH-CAVEAT** — the boot-time systemd unit write defect below |
| Composed Client entry | WORKS — driven in a real Chromium against a booted `0.2.1-alpha.2` daemon |

Treat `0.2.0-rc.2` as the reference target and `0.2.1-alpha.2` as certified with
the two caveats below. The Web Daemon caveat is addressed by the `0.1.3` guard;
the Mentor caveat by the runtime-context fix recorded here.

**Mentor failed on every consultation on `0.2.1-alpha.2` (found 2026-10-13).**
`suppressRuntimeContext()` no longer removes dynamic context marked
`required: true`: `dsh-working-directory` registers
`working-directory:current` as required, and `SystemPrompt.refreshContext()` /
`assemble()` retain it under suppression. The Mentor child surface therefore
carries one DSH-owned `runtime-context` snapshot, which the pre-dispatch history
check rejected as an unsubmitted user message. No model request was sent and no
cost was incurred; the caller saw the generic
`MENTOR_INCOMPLETE: no committed assistant message was produced` because the
guard throws before `live.start()` emits any assistant-stream frame. The guard
now accepts only the snapshot the child session already recorded (matching id,
`form: snapshot`), keeps rejecting every other user source, and reports the
recorded `turn/end` reason instead of the generic message. Verified by replaying
the real failing child session
(`sessions/_no-cwd/mt_2e48d0dd-2c17-4283-9c91-7359768adc83`): the old check
reproduces the exact error, the new check accepts it. `0.2.0-rc.2` never injected
that snapshot, which is why the earlier certification run passed.

**Work Journal was verified end-to-end on `0.2.1-alpha.2`.** The same result was
then reproduced on the **live** profile after a daemon restart: `POST
/api/work-journal` returned `200` from `/root/.dsh`, and a Chromium session
against the live GUI read the rail as 新建会话 → 插件 → 自动化任务 → 工作日志,
clicked it, and rendered the real report. The cold index build took about 100 s,
which is the documented first-query cost, not a fault.

The two later fixes were verified the same way. The 今日 range — the one that
blanked the page — was clicked in a real browser after 本周 and rendered with no
console error, and switching back to 本周 kept the panel mounted. On live data
that range rendered its report (3 sessions, 866 tool calls) with no console error.

The isolated-profile evidence: an isolated profile
(a copy of the live patch layer with the Web Daemon row redirected to
`enabled: false`, port `3098`, `systemdUnit: cutover-3092.service`,
`systemdScope: user`) booted the packed `0.1.3` build. `POST /api/work-journal`
returned `200` with a real `status`/`query` payload, the envelope guards answered
`415` for a wrong content type and `bad-request` for a wrong method name, and the
old `POST /work-journal` still answered `405` — the defect, and only the defect,
is gone. A real Chromium session then read the left rail as, in order,
新建会话 → 插件 → 自动化任务 → **工作日志**, clicked the button, and rendered the
panel with its range switch and `0/3` index line, with no console errors. The
served bundle contains the repository's `client.js` verbatim.

**Test counts.** The current `0.1.3` tree passes **482/482** (2 skipped) on `0.2.0-rc.2`. The
alpha verification run predates both the `0.1.3` Web Daemon guard test and the
Work Journal route/rail tests. The Web Daemon guard has been exercised on
`0.2.0-rc.2` (red-green: the test fails when the guard is neutralised); the Work
Journal fix is covered by the alpha end-to-end run described above rather than by
a unit test.

**What was verified on `0.2.1-alpha.2`.**

- The installer gate admits `0.1.3` with the widened peer window, so
  `dsh plugin --profile web add` succeeds with **no** `allow-version` exemption.
- The composed profile then boots on the `0.2.1-alpha.2` runtime.
- Repo-side verification on the `0.2.0-rc.2` runtime: `npm run build` (one Client
  entry, 7 feature factories), `npm run check` (8 Host exports, one anchor, all
  JavaScript sources) and `npm test` all passed. That pass recorded **365/365**;
  the tree has grown since, and the current count is in **Test counts** above.
- A separate run in an isolated copy of the repository whose `node_modules` was
  fully replaced with the real `0.2.1-alpha.2` tree passed `npm run build`,
  `npm run check` and `npm test` — **364/364, zero failures, zero skips**, broken
  down as auth-webserver 113, work-journal 78, mentor 57, web-daemon 37,
  session-mode 35, delete-session 19, session-list-cache 18, top-level 7. The
  `client.js` it rebuilt is byte-identical to this repository's committed output,
  which independently confirms that no Client source needed to change. (364 rather
  than 365 because that run predates the `0.1.3` Web Daemon guard test.)
- The suite was **booted live against the alpha runtime** and exercised there:
  `toolNames=[work_journal, working_directory]` and
  `commandNames=[agent-mode, export, feedback, journal, mentor, permission]`
  registered; Delete Session `POST {}` returned `400 "sessionId is required"`;
  the Monaco asset served `200`/`350112` bytes; Web Daemon metrics and state
  returned valid JSON; and session-list-cache coalescing was proven (3 calls → 1
  underlying scan).
- `npm pack` produced `yiln-dsh-dsh-plugins-0.1.3.tgz` (348.8 kB, 67 files); its
  own `package.json` inside the tarball carries version `0.1.3` and all 31 DSH
  peers at `>=0.2.0-rc.2 <0.2.1`. The tarball's `README.md` matches the root
  `README.md` byte-for-byte. (Note: `COMPATIBILITY.md` is deliberately not in the
  published `files` list, so these notes are repository documentation only.)

The alpha-package test run and the live alpha boot are the alpha-verification
workstream's evidence (report at `/tmp/team-reports/alpha-compat.md`), not a
re-run by the release pass; the release pass reproduced the `0.2.0-rc.2` run and
the pack/install checks itself.

**What was NOT verified.** This is the important half of this section:

- The **Client entry's visual and interaction behaviour** was certified only for
  the parts a browser pass has reached. The Work Journal panel — its left-rail
  button, report list, spans, detail view and search — was driven in a real
  Chromium against the running `0.2.1-alpha.2` GUI, and the other modules'
  Slots were exercised at loader level rather than by pointer. Modules whose
  panels no browser pass has touched remain uncertified at that layer.
- The alpha run imports **9 of the 31 declared DSH peers** as real module
  specifiers (`dsh-tools`, `dsh-session`, `dsh-scope`, `dsh-atomic-write`,
  `dsh-system-prompt`, `dsh-subagent`, `dsh-llm`, `dsh-client-connection`,
  `dsh-client-ui-primitives`), plus `@deepseek-ai/cordis` and
  `@deepseek-ai/schemastery` and one non-peer
  (`dsh-experimental-tool-agent-team`, optionally, in a test). The other 22 peers
  are declared because the composed bundle injects them; they are validated by the
  installer gate and by live registration, not by being imported in a test.
- `0.2.0-rc.3`, `0.2.0` final and `0.2.1-alpha.1` were not installed or exercised
  in any form; they are inside the window only because the range admits them.
- `0.2.1` final and every later line are outside the window by design and were
  not tested.
- The live `web` profile was not upgraded in this pass. A cutover rehearsal
  against a copy of the live profile is a separate workstream.

**Upstream symbols that no longer exist in alpha (currently unused here).** These
were present in the `0.2.0-rc.2` surface and are gone in `0.2.1-alpha.2`. Nothing
in this repository references any of them, so they are recorded as a forward
hazard rather than a defect — a future change that reaches for one of them will
fail on the alpha line:

- `ToolPresentationMode`'s `'both'` member
- `JobKindMap['subagent']`
- `livePresetMounts`, `serviceForAgent`, `standingMountFor`
- `useInput` / `bindDraftMirror`
- the 3-argument `isTrustedApiRequest` API (note the repository does define its own
  local **1-argument** `isTrustedApiRequest(req)` helper in
  `src/web-daemon/index.js`; that is a private same-named function, not a use of
  the removed upstream API)

**The Web Daemon boot-time unit write is unconditional, but is now refused across
DSH homes.** This is both a behavior note and the record of a real defect fixed in
`0.1.3`.

The write itself is still unconditional. The Web Daemon Host row calls
`manager.refreshUnit(...)` on every boot (`src/web-daemon/index.js:1862`,
`apply()` → `refreshUnit()`), deliberately outside the
`if (!isWorker && state.config.enabled)` block above it. That is the intended
repair loop: the generated `ExecStart` embeds the absolute interpreter path, which
on an nvm install carries the Node version, so a Node upgrade would otherwise
leave a stale path that systemd rejects with `203/EXEC` and never repairs itself.
So `enabled: false` suppresses autostart and `systemctl enable`, **not** unit file
generation, and the unit on disk can change even with the feature switched off.
Treat the unit file as boot-derived state, not as configuration.

**Before `0.1.3` that write could cross installations.** The unit path comes from
configuration (`systemdUnit` plus `systemdScope: system` names a real host unit),
so a boot from a throwaway `DSH_HOME` — a rehearsal, a test profile, a second
install — would rewrite the production supervisor to run *its* interpreter, *its*
`PATH` and *its* home. This was observed on this machine, not theorised: three
isolated-profile boots rewrote `/etc/systemd/system/dsh-web.service` to point at a
test home and left it disabled. The live daemon was never restarted, so the
poisoned unit was never executed, and the unit was restored from the running
process's own environment. The danger was entirely latent and would have fired on
the next `systemctl restart` or at boot.

**`0.1.3` makes that impossible by default.** `writeSystemdUnit()` now calls
`assertUnitHomeOwner(target, previous)` before writing
(`src/web-daemon/index.js:1600`). It reads the `Environment=DSH_HOME=` value the
existing unit records and:

- repairs when the recorded home matches the booting process (the intended case,
  including a unit written before that line existed, which records no owner and is
  free to adopt); and
- **refuses** when the unit is owned by a different `DSH_HOME`, raising
  `web-daemon: refusing to overwrite <path>: it is owned by the DSH home <other>,
  not the current <home>`.

The refusal is non-fatal by design: `apply()` catches it and logs a warning
(`src/web-daemon/index.js:1863-1866`), so the daemon still serves. The escape
hatches are to give the other profile its own `systemdUnit` or to use
`systemdScope: user`.

**The alternative route, for users who do not want to rebuild.** A user who stays
on the published `0.1.2` artifact can instead grant a per-exact-version exemption
and keep the old peer window:

```bash
dsh plugin --profile web allow-version @yiln-dsh/dsh-plugins@0.1.2 --dsh-version 0.2.1-alpha.2 --accept-risk
```

This path was also verified to work. The tradeoff is real: the exemption is
scoped to that one exact plugin version and that one exact runtime version, so it
must be **re-granted on every runtime bump** and it records an explicit
risk acceptance for a peer window that no longer matches. The widened window
instead travels with the artifact, needs no per-profile bookkeeping, and is what
`0.1.3` ships — but it is a claim about installability, and the feature-level
certification caveat above still applies either way.

**Upgrade-boundary hazard: retired bundles are dropped from the profile.** This is
upstream DSH behavior, not something this plugin causes, and it is worth knowing
before an upgrade. In the `0.2.1-alpha` line,
`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`
declares:

```js
const RETIRED_BUNDLES = new Set(["@deepseek-ai/dsh-experimental-schedule-bundle"])
```

`loadProfileDirectory()` runs `dropRetiredBundles()` first, which removes every
listed retired bundle from `dsh.profile.bundles` and **rewrites the profile's
`package.json`**. (The `0.2.0-rc.2` installation currently on this machine has no
such set — it ships `OPTIONAL_BUNDLES` instead — so this only appears once the
runtime moves to the alpha line.)

Consequences for the `web` profile on this machine:

- The live profile declares `@deepseek-ai/dsh-experimental-schedule-bundle` in
  `dsh.profile.bundles`, so the upgrade **silently drops that entry** from the
  bundle list. Expect the manifest to change even though the operator changed
  nothing.
- The bundle is **not installed anywhere** on this machine: it is absent from both
  `/root/.dsh/profiles/web/node_modules/` and `/root/.dsh/profiles/node_modules/`,
  and from the rest of `/root/.dsh`. It was therefore already inert (an
  unresolvable bundle is skipped at load), so its removal is behaviorally benign.
- It is nonetheless a real profile mutation, and it is the concrete reason a
  pre-upgrade backup of `profiles/web/package.json` matters: after the upgrade the
  file legitimately differs from the backup, and that difference should be
  expected rather than mistaken for corruption.

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
