# @yiln-dsh/dsh-plugins

One DSH Web plugin package containing eight internal feature modules. This
workspace is the project root; dependencies, versioning, build, tests and
publication are managed here, not in individual feature directories.

Current version: `0.1.3`. Verified targets: DSH `0.2.0-rc.2` (reference; 482/482
tests) and `0.2.1-alpha.2` (all eight modules verified, boots live, and driven in
a real browser against the running GUI). The DSH peer window is
`>=0.2.0-rc.2 <0.2.1`, so the installer admits the `0.2.1-alpha` line and no
version exemption is needed. See [compatibility notes](COMPATIBILITY.md) for the
exact scope.

`0.1.3` also fixes a safety defect: Web Daemon re-derives its systemd unit on
every boot, and before this release a boot from a different `DSH_HOME` (a
rehearsal or second profile) could overwrite the host unit to point at that other
installation. The write is now refused when the existing unit belongs to a
different `DSH_HOME`; the refusal is non-fatal and logged.

## Features

| Module | Loader row ID | Purpose |
| --- | --- | --- |
| Auth Webserver | `webserver-auth` | Authenticated LAN gateway, TOTP/Passkeys, PWA, mobile layout and configuration editor. |
| Delete Session | `dsh-delete-session` | Confirmed single/batch deletion with subagent cascade and guarded persistence paths. |
| Git Graph | `dsh-git-graph` | Right-sidebar Git history, working-tree changes and file diffs. |
| Mentor | `dsh-mentor` | Isolated tool-less consultations, per-session serial queue, durable replay and global settings. |
| Session List Cache | `session-list-cache` | Coalesces and caches concurrent session enumeration. |
| Web Daemon | `web-daemon` | Systemd management, server metrics and interrupted-session recovery. |
| Session Mode | `session-mode` | Per-session `normal` / `delegate-writes` permissions: the restricted main agent gets a pruned tool catalog plus an execution guard, with separate system prompts. |
| Work Journal | `dsh-work-journal` | Daily/weekly/monthly reports of what this harness was used for, read from the durable session store: a `work_journal` tool, a `/journal` command, and a left-rail 工作日志 panel over scheduled, searchable reports. |

A single installed bundle owns these modules. Their separate Cordis rows retain
independent Config schemas and the existing settings namespaces. Auth sessions,
Passkeys, Mentor journals, recovery records, HTTP routes and Git tab identities
keep their original names and locations.

## Install

Install the published package (this command applies once `0.1.3` is published;
`0.1.2` is the current npm `latest`):

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugins@0.1.3
```

The declared DSH peer window is `>=0.2.0-rc.2 <0.2.1`. Within it the installer's
peer gate admits both the `0.2.0` line and the `0.2.1` prerelease line, so no
`dsh plugin allow-version` exemption is required for `0.2.1-alpha.2`. A future
`0.2.1` final release or a later line is deliberately outside the window and
needs a fresh compatibility pass.

Or install the current workspace build:

```bash
npm install
npm run build
dsh plugin --profile web add file:/path/to/dsh-plugin
```

Refresh the local `file:` installation after source changes. Restart the daemon
for Host changes and refresh the browser for Client changes; a running process
must not be assumed to pick up copied files automatically.

A `file:` directory dependency is resolved from the lockfile, so pnpm may report
`Already up to date` and project nothing even when the package gained files.
Remove the projected package before re-adding it, or the new module will be
missing from the composed profile:

```bash
rm -rf "$DSH_HOME/profiles/web/node_modules/@yiln-dsh/dsh-plugins"
dsh plugin --profile web add file:/path/to/dsh-plugin
```

Confirm the composed tree carries the row before restarting:

```bash
dsh --profile web --dump-config | grep -c session-mode
```

## Migration From Six Packages

Do not activate the suite alongside the six old bundles: their row IDs, routes
and registrations would overlap. Back up the Web profile and plugin state,
stop the worker from an independent process, remove the old six packages, install
the suite and migrate explicit old `name` overrides in the user patch. Preserve
all Config values, row IDs and state directories. Restart and refresh the GUI.

The migration helper is dry-run by default through an explicit mode:

```bash
node scripts/migrate-profile.mjs --check /absolute/profile/cordis.patch.yml
node scripts/migrate-profile.mjs --write /absolute/profile/cordis.patch.yml
```

It changes only known Loader module addresses, preserves comments and `!!js`,
never evaluates expressions, and verifies that other configuration values stay
identical. It does not uninstall/install packages or remove persisted state.

## Session Modes

Use the switch to the right of the permission control in the composer toolbar,
or `/agent-mode on` and `/agent-mode off`. Turning delegated writes on makes the
main agent read-only while workers perform edits and command execution: unaudited
tools leave the main agent's model-facing catalog, and a monotonic guard still
refuses them if a call arrives anyway. Agent Teams coordination tools stay
available to the coordinating main agent. The
switch label and both state words are localized through the Client locale
dictionary. The two modes have independent `normalPrompt` and
`delegateWritesPrompt` Config fields. Selections survive restart; worker
permissions and prompts use the mode captured at creation.
See [Session Mode](<docs/modules/session-mode.md>) for configuration and boundaries.

## Work Journal

Ask the harness what you did, without preparing anything in advance. The journal
reads the same session logs the conversations are replayed from, so it covers
history from before it was installed and cannot disagree with what happened.

- In a conversation: ask "我昨天做了什么" / "总结一下这周" and the agent calls
  `work_journal`.
- Without the model: `/journal week`, `/journal 2026-09-13`, `/journal status`,
  `/journal rebuild`.
- In the GUI: the "工作日志" button on the left rail, beside 插件 and 自动化任务
  and below 新建会话, listing generated reports newest-first with the time span
  each one covers, plus a search box over them.

With `schedule: true` the module also writes reports on its own: yesterday's
report every midnight, the completed Saturday–Friday week each Saturday, and the
previous calendar month on the 1st. Each one is a Markdown file plus a metadata
record under `<DSH_HOME>/work-journal/`, kept permanently and indexed in SQLite
for keyword and semantic search. Scheduled generation spends model tokens
unattended, so it is off by default.

The first query after a restart builds the whole index; later passes read only
what changed. A report that could not be built from the whole store says so
instead of quietly under-counting. Reports count your own prompts, tool calls, files
written, commands run, per-day active windows, and per-project totals. See
[Work Journal](<docs/modules/work-journal.md>) for the projection rules, the
incremental index, and configuration.

## Development

```bash
npm run build
npm run check
npm test
DSH_EDITOR_QA_URL=http://isolated-test-host:3095/ npm run test:editor
DSH_MODE_QA_URL=http://127.0.0.1:<isolated-port>/ npm run test:modes:browser
npm pack
```

The browser test uses the synthetic fixture in the Auth module and refuses the
production port. Do not point mutating test journeys at production.

## Layout

- `package.json`: the only plugin package manifest and version.
- `cordis.patch.yml`: root discovery anchor and eight feature rows.
- `index.js`: no-op Host discovery anchor.
- `src/<feature>/`: internal Host/Client implementations and feature tests.
- `src/features.js`: canonical identities for composition and migration checks.
- `client.js`: generated single Client entry; edit feature sources instead.
- `scripts/`: client generation, verification and profile migration.
- `test/`: root-package and migration contracts.
- `docs/`: feature notes, compatibility research and verification evidence.
- `skills/`: repository skill material, not a second plugin package.

The [doc-driven-development source](skills/doc-driven-development/SKILL.md) keeps
human-readable domain/module contracts in a small, uniform documentation layout.
Its [module example](skills/doc-driven-development/examples/module-boundaries.md)
shows public entry points, state ownership and scoped document maintenance.
Run `node skills/doc-driven-development/scripts/check.mjs` for the skill's
isolated package regressions; these materials are not installed or published
by the plugin build, and existing project documents are not migrated automatically.

## Release

Bump the root version and update this README and compatibility notes together.
Run the build, syntax checks, tests and a packed-install smoke test. Commit and
push only when requested; publish with `npm publish --access public` only after
an explicit release request. Internal modules do not have independent versions.
