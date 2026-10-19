# @yiln-dsh/dsh-plugins (workspace)

A pnpm workspace of **independently installable** DSH Web plugins. Each plugin
lives under `pkgs/<name>/` as its own package (`@yiln-dsh/dsh-<name>`) with its
own `dsh.bundle` layer, Loader row, and Client module. A profile installs only
the plugins it actually runs.

The workspace root is private and holds no plugin code: no `dsh.bundle`, no
`cordis.patch.yml`, no aggregate Client bundle.

Current version: `0.3.0`. Verified target: DSH `0.2.1-rc.2`. See
[compatibility notes](COMPATIBILITY.md) for the exact scope.

## Breaking change in `0.3.0`: two packages retired, three renamed

Two packages were removed and three were renamed. A profile that still names an old one
will not mount, so update it before restarting.

| Before | After | Why |
| --- | --- | --- |
| `pkgs/daemon` (`@yiln-dsh/dsh-daemon`) | `pkgs/gateway` (`@yiln-dsh/dsh-gateway`) | "daemon" described every plugin here; this one is the entry to other machines |
| `pkgs/web-daemon` (`@yiln-dsh/dsh-web-daemon`) | `pkgs/supervisor` | it manages systemd and recovers sessions, not the web surface |
| `pkgs/session-mode` (`@yiln-dsh/dsh-session-mode`) | `pkgs/delegate-mode` | matches the mode it controls |
| `pkgs/auth-webserver` | — | the Host ships `dsh-authorization`, which serves the login page itself |
| `pkgs/fleet` | — | `gateway` does the same job with a reverse tunnel instead of SSH |

Three names in this release are unchanged on purpose, because each one holds data that a
rename would strand: the `/api/session-mode` route and its RPC method, the
`/root/.dsh/daemon/` and `/root/.dsh/session-modes/` state directories, and the
`delegate-writes` value stored per session.

## Breaking change in `0.2.0`

Two modules were removed along with their dependencies
(`@huggingface/transformers`, `sqlite-vec`):

- **Mentor** (`dsh-mentor`). Superseded by the `mentor` **Agent Preset**
  (`subagent({ agent_preset: 'mentor' })`), which reaches the same goal through
  DSH's own continuable subagents.
- **Work Journal** (`dsh-work-journal`). The `work_journal` tool, `/journal`
  command, `POST /api/work-journal` route, and the report scheduler are gone.

Stored data is **not** touched: reports under `<DSH_HOME>/work-journal/` remain
on disk until deleted deliberately.

## Breaking change in `0.2.1`: one package became nine

The single aggregate package `@yiln-dsh/dsh-plugins` was split into standalone
packages. Nothing is published to npm any more; a profile installs a package
directly from this repository by path.

| Before | After |
| --- | --- |
| `@yiln-dsh/dsh-plugins` (one package) | nine packages under `pkgs/` |
| root `cordis.patch.yml` | one `cordis.patch.yml` per package |
| generated 292 KB `client.js` | each package ships its own Client module |
| `exports["./fleet"]` subpaths | one package per plugin, no subpaths |

Loader row IDs, HTTP paths, locale/slot IDs, cookie names and state directories
are unchanged, so an existing profile only needs new package addresses — see
[Migration](#migration-from-the-aggregate-package).

## Packages

| Package | Loader row ID | Purpose |
| --- | --- | --- |
| [`pkgs/delete-session`](pkgs/delete-session) | `dsh-delete-session` | Confirmed single/batch deletion with subagent cascade and guarded persistence paths. |
| [`pkgs/git-graph`](pkgs/git-graph) | `dsh-git-graph` | Right-sidebar Git history, working-tree changes and file diffs. |
| [`pkgs/session-list-cache`](pkgs/session-list-cache) | `session-list-cache` | Coalesces and caches concurrent session enumeration. |
| [`pkgs/gateway`](pkgs/gateway) | `gateway` | Federation gateway: edges dial in over a reverse tunnel, and its panel lists and switches between them. |
| [`pkgs/supervisor`](pkgs/supervisor) | `supervisor` | Systemd management, server metrics and interrupted-session recovery. |
| [`pkgs/delegate-mode`](pkgs/delegate-mode) | `delegate-mode` | Per-session `normal` / `delegate-writes` permissions with pruned catalogs and separate system prompts. |
| [`pkgs/tool-restrict-presets`](pkgs/tool-restrict-presets) | `tool-restrict-presets` | Applies `agent.ctx.tools.restrict({ allow: [] })` to every Agent running a listed Agent Preset. |
| [`pkgs/desktop-vnc`](pkgs/desktop-vnc) | `dsh-desktop-vnc` | Right-sidebar tab showing a Chromium browser inside a nested Xephyr display. |

## Install

Install one plugin straight from this repository:

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/delegate-mode"
```

Install several by repeating the path form:

```bash
dsh plugin --profile web add \
  "github:<owner>/dsh-plugin#path:/pkgs/git-graph" \
  "github:<owner>/dsh-plugin#path:/pkgs/delegate-mode"
```

Or install a local checkout by path:

```bash
dsh plugin --profile web add "file:/path/to/dsh-plugin/pkgs/delegate-mode"
```

Refresh a local `file:` installation after source changes, then restart the
daemon for Host changes and refresh the browser for Client changes.

A package missing `dsh.bundle.patch` installs as an inert dependency and mounts
nothing. Confirm the composed tree carries the row before restarting:

```bash
dsh --profile web --dump-config | grep -c delegate-mode
```

## Migration from the aggregate package

A profile written against the old aggregate package names either
`@yiln-dsh/dsh-plugins/<feature>` or `@yiln-dsh/dsh-plugin-<feature>`. Back up
the profile, then rewrite those addresses with the structured helper:

```bash
node scripts/migrate-profile.mjs --check /absolute/profile/cordis.patch.yml
node scripts/migrate-profile.mjs --write /absolute/profile/cordis.patch.yml
```

It changes only known Loader module addresses, preserves comments and `!!js`,
never evaluates expressions, and verifies that other configuration values stay
identical. It does not uninstall or install packages, and does not remove
persisted state.

Then uninstall the aggregate package and install the packages that profile
actually used:

```bash
dsh plugin --profile web remove @yiln-dsh/dsh-plugins
dsh plugin --profile web add "file:/path/to/dsh-plugin/pkgs/gateway" ...
```

Do not run both the aggregate package and the split packages at once: their row
IDs overlap.

## Session Modes

Use the switch to the right of the permission control in the composer toolbar,
or `/agent-mode on` and `/agent-mode off`. Turning delegated writes on makes the
main agent read-only while workers perform edits and command execution. The
switch label and both state words are localized through the Client locale
dictionary. The two modes have independent `normalPrompt` and
`delegateWritesPrompt` Config fields. Selections survive restart; worker
permissions and prompts use the mode captured at creation.
See [Delegate Mode](<docs/modules/delegate-mode.md>) for configuration and boundaries.

## Development

```bash
npm run check                       # validate every package as a mountable plugin
npm test                            # workspace + per-package suites
DSH_EDITOR_QA_URL=http://isolated-test-host:3095/ npm run test:editor
DSH_MODE_QA_URL=http://127.0.0.1:<isolated-port>/ npm run test:modes:browser
```

There is no build step: a package's Client source is already its own
`window.__ModuleLoader__.load({ id, factory })` module, and its `id` must equal
the package name. `npm run check` enforces that.

The browser tests use the synthetic fixture in the Auth package and refuse the
production port. Do not point mutating test journeys at production.

## Layout

- `package.json`: private workspace root — scripts only, no plugin surface.
- `pnpm-workspace.yaml`: `pkgs/*` is the package glob.
- `pkgs/<name>/package.json`: the plugin manifest (`dsh.bundle`, `dsh.client`, `exports`).
- `pkgs/<name>/cordis.patch.yml`: exactly one Loader row naming this package.
- `pkgs/<name>/index.js`: Host half.
- `pkgs/<name>/client.js`: Client half, self-registering.
- `pkgs/<name>/test/`: package tests.
- `scripts/check.mjs`: per-package mounting validation.
- `scripts/migration.mjs`: legacy address migration.
- `test/`: workspace-level contracts.
- `docs/`: module notes, compatibility research and verification evidence.

The [doc-driven-development source](.agents/skills/doc-driven-development/SKILL.md)
keeps human-readable domain/module contracts in a small, uniform documentation
layout.

## Release

Each package carries its own version: bump only the packages that changed, plus
the workspace root when the layout changes. Run `npm run check`, `npm test`, and a
smoke test that installs a package from a clean profile. Commit and push only
when requested. This repository has **no npm publication target** — installing
from GitHub is the supported path.
