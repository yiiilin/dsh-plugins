# AGENTS.md

## Project Layout

- This repository is a **pnpm workspace**, not a single npm package. The root
  `package.json` is private, declares no `dsh.bundle`, and exists only for
  scripts and shared tooling.
- Every plugin is an independently installable package under `pkgs/<name>/`,
  published as `@yiln-dsh/dsh-<name>`. Nothing is published to npm: a profile
  installs a package straight from GitHub by path, and installs only what it
  needs.
- Each `pkgs/<name>/` owns its whole surface: `package.json` (`dsh.bundle`,
  optional `dsh.client`, `exports`), `cordis.patch.yml` (exactly one Loader
  row), `index.js` (Host half), its Client module, tests and README.
- A package's Client half is a self-contained `window.__ModuleLoader__.load({ id, factory })`
  module whose `id` **equals its package name**. There is no build step and no
  aggregate bundle; edit the Client source and run `npm test`.
- There is no root `cordis.patch.yml`, `index.js`, `client.js`, or `src/`.
  Adding a plugin means adding a directory under `pkgs/`, never editing a
  central registry.

## Install model

```sh
dsh plugin --profile <p> add "github:<owner>/<repo>#path:/pkgs/<name>"
```

A package without `dsh.bundle.patch` installs as an inert dependency and mounts
nothing, so `scripts/check.mjs` asserts the patch exists and names its own
package. Never add an aggregate "install everything" package: the point of the
split is that a profile carries only the plugins it runs.

## Compatibility and Migration

Preserve Loader row IDs, HTTP paths, locale/slot IDs, Git tab identity, cookie
names, Auth/Daemon state directories and Mentor producer/journal identities.
Only package/module addresses change when reorganizing the suite.

Profile patches written against the retired aggregate package still name
`@yiln-dsh/dsh-plugins/<feature>` or `@yiln-dsh/dsh-plugin-<feature>`. Rewrite
them with the structured helper (`scripts/migration.mjs` —
`npm run migrate -- --check|--write <patch>`); never globally replace legacy
strings or print configuration secrets.

Local `file:` installs must be refreshed after edits. Test installs in an
isolated DSH profile before changing the live profile. A live restart must run
as an independent task with backup, health checks and rollback.

## Verification

Run `npm run check` and `npm test` before committing. `check` validates every
package as a mountable plugin (bundle row, Client id, declared injections);
`test` runs the workspace plus per-package suites.

Use the Auth fixture and `npm run test:editor` for configuration-editor browser
regressions. Mutating browser tests must use isolated data and test credentials.

## UI Text

All user-visible Client copy goes through each package's locale dictionary.
Add matching keys to both Chinese and English dictionaries in the same change.

## Release

Each package carries its own version; bump only the packages that changed, plus
the root version when the workspace layout changes. Update the root README and
compatibility notes in the same change. Commit/push when requested, and do not
publish without an explicit release request — this repository intentionally has
no npm publication target.

## Agent skills

### Issue tracker

Issues and specs live as markdown under `.scratch/<feature>/`, one file per ticket,
`Status:` line for triage state. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage role strings, each equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` plus `docs/adr/`, shared by every `pkgs/*` package. See `docs/agents/domain.md`.

### Dev flows

`dev-flow` routes incoming work to `new-feature`, `feature-upgrade`, or `bug-fix`;
those three wrap Matt Pocock's engineering skills. They need his skill set
installed, and this table is that per-repo setup.

### CodeGraph onboarding

`.agents/skills/init-code-graph/SKILL.md` carries the full install-and-index
procedure; it is `disable-model-invocation: true`, so only the user runs it —
`/init-code-graph`. Point them at it rather than restating the steps here.

If a project has no index yet, do not build one yourself: upstream requires that
indexing stays the user's decision. Note that `codegraph status` exits `0` even
with no index, so read `status --json`'s `initialized` field instead of the exit code.

