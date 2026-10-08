# @yiln-dsh/dsh-plugins

One DSH Web plugin package containing seven internal feature modules. This
workspace is the project root; dependencies, versioning, build, tests and
publication are managed here, not in individual feature directories.

Current version: `0.1.1` (published to npm as public). Verified target:
DSH `0.2.0-rc.2`.

## Features

| Module | Loader row ID | Purpose |
| --- | --- | --- |
| Auth Webserver | `webserver-auth` | Authenticated LAN gateway, TOTP/Passkeys, PWA, mobile layout and configuration editor. |
| Delete Session | `dsh-delete-session` | Confirmed single/batch deletion with subagent cascade and guarded persistence paths. |
| Git Graph | `dsh-git-graph` | Right-sidebar Git history, working-tree changes and file diffs. |
| Mentor | `dsh-mentor` | Isolated tool-less consultations, durable replay and global settings. |
| Session List Cache | `session-list-cache` | Coalesces and caches concurrent session enumeration. |
| Web Daemon | `web-daemon` | Systemd management, server metrics and interrupted-session recovery. |
| Session Mode | `session-mode` | Per-session `normal` / `delegate-writes` permissions: the restricted main agent gets a pruned tool catalog plus an execution guard, with separate system prompts. |

A single installed bundle owns these modules. Their separate Cordis rows retain
independent Config schemas and the existing settings namespaces. Auth sessions,
Passkeys, Mentor journals, recovery records, HTTP routes and Git tab identities
keep their original names and locations.

## Install

Install the published package:

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugins@0.1.1
```

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
- `cordis.patch.yml`: root discovery anchor and seven feature rows.
- `index.js`: no-op Host discovery anchor.
- `src/<feature>/`: internal Host/Client implementations and feature tests.
- `src/features.js`: canonical identities for composition and migration checks.
- `client.js`: generated single Client entry; edit feature sources instead.
- `scripts/`: client generation, verification and profile migration.
- `test/`: root-package and migration contracts.
- `docs/`: feature notes, compatibility research and verification evidence.
- `skills/`: repository skill material, not a second plugin package.

## Release

Bump the root version and update this README and compatibility notes together.
Run the build, syntax checks, tests and a packed-install smoke test. Commit and
push only when requested; publish with `npm publish --access public` only after
an explicit release request. Internal modules do not have independent versions.
