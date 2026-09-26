# dsh-plugins

A repository of plugins for DeepSeek Harness (DSH). Each plugin lives in its
own directory.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`@yiln-dsh/dsh-plugin-auth-webserver`](./dsh-plugin-auth-webserver) | Auth-gated reverse proxy with Host/Origin policy, HTTPS/TOTP, sliding sessions, WebSockets, authenticated remote Settings/Models support, and a resume watchdog that rebuilds the realtime connection after a phone lock. |
| [`@yiln-dsh/dsh-plugin-git-graph`](./dsh-plugin-git-graph) | Contribute a Git Graph page tab to the DSH Web right Sidebar: lane graph, commit and working-tree diffs, and uncommitted changes. |
| [`@yiln-dsh/dsh-plugin-mentor`](./dsh-plugin-mentor) | Add an on-demand, isolated Mentor Agent tool, durable thread recovery, Web status/reset commands, a session-scoped history tab, and one global settings page under Settings > Plugins. |
| [`@yiln-dsh/dsh-plugin-delete-session`](./dsh-plugin-delete-session) | Add confirmed permanent-delete actions for the current session, session-row menus, and selected session batches. |
| [`@yiln-dsh/dsh-plugin-web-daemon`](./dsh-plugin-web-daemon) | Manages `dsh web` as a real systemd unit, auto-resumes the sessions **and running subagents** that were interrupted by a restart, shows server CPU/memory/network/filesystem status in the sidebar footer above the Settings action, and edits its configuration from the GUI Settings section. |
| [`@yiln-dsh/dsh-plugin-session-list-cache`](./dsh-plugin-session-list-cache) | Collapse the repeated full-store session enumerations the Web GUI fires concurrently, by caching and coalescing `sessionQuery.listSessions()`. |

## Install

Published plugins are available from the public npm registry under the `@yiln-dsh`
scope. Workspace entries may not have been published yet; plugins are installed
per profile:

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
```

Substitute a published package name from the table above. `dsh plugin` forwards its
argument straight to pnpm, so the same command accepts two development specs:

- **Source directory.** Point at a working tree with a `file:` spec, so pnpm
  records it as a local dependency rather than trying to resolve it by name:

  ```bash
  dsh plugin --profile web add file:/path/to/dsh-plugin-auth-webserver
  ```

- **Tarball.** Pack one directory to hand a single build to someone else:

  ```bash
  cd /path/to/dsh-plugin-auth-webserver && pnpm pack
  dsh plugin --profile web add file:/path/to/yiln-dsh-dsh-plugin-auth-webserver-<version>.tgz
  ```

This file deliberately does not spell out a tarball's version: the name carries
whatever `package.json` held when it was packed, so read the version there
instead of copying a literal that goes stale at the next release.

**A `file:` install is hardlinked, not copied.** The files in the profile's
`node_modules` share an inode with the source tree, so editing a file that
already exists takes effect on the next daemon start with no reinstall. A file
that does not exist there yet — a new module — is *not* picked up, because
nothing links it; reinstall that plugin to add it.

## Upgrading from a local install

A profile that installed a plugin from a directory or tarball keeps that spec
until it is replaced. Switch it to the published package with a remove and add:

```bash
dsh plugin --profile web remove @yiln-dsh/dsh-plugin-auth-webserver
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
```

## Versioning

Published bundle plugin versions are listed below. Workspace-only packages are marked `unpublished`:

| Package | Version |
| --- | --- |
| `@yiln-dsh/dsh-plugin-auth-webserver` | `0.10.4` |
| `@yiln-dsh/dsh-plugin-delete-session` | `0.4.5` |
| `@yiln-dsh/dsh-plugin-git-graph` | `0.2.2` |
| `@yiln-dsh/dsh-plugin-mentor` | `0.2.1` |
| `@yiln-dsh/dsh-plugin-web-daemon` | `0.8.2` |
| `@yiln-dsh/dsh-plugin-session-list-cache` | `0.1.1` |

Each plugin's version is the `version` field in its own `package.json`.
Semantic versioning is recommended: patch for fixes, minor for additive
features, major for breaking changes.

The version controls npm ranges, tarball file names, and package metadata.
A `file:` source install uses the source tree as-is. A direct GitHub install
is pinned by the commit or branch after `#`, not by `package.json` alone.

See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the tested DSH package lines,
the rc.2/alpha.2 compatibility seams, and the release smoke checks.

## Distributing a plugin

`dsh plugin` forwards pnpm dependency specs, so a plugin in this repo can be
shared three ways:

- **npm package (recommended).** Publish one plugin directory, then install by
  name:

  ```bash
  cd dsh-plugin-auth-webserver && npm publish --access public
  dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
  ```

- **Tarball.** Pack one plugin directory and hand out the `.tgz`. `npm pack`
  names it after the package's current version, so install whatever it wrote:

  ```bash
  cd dsh-plugin-auth-webserver && npm pack
  dsh plugin --profile web add file:"$PWD"/yiln-dsh-dsh-plugin-auth-webserver-*.tgz
  ```

- **Direct GitHub URL.** This works only when the repository root itself is the
  plugin package (a single-plugin repo). This repo keeps each plugin in a
  subdirectory and its root is not a `package.json`, so
  `github:user/repo#ref` installs a root package instead of a plugin here.
  If you want GitHub-only installs, publish each plugin as its own repository,
  or point `dependencies` at a plugin tarball URL.
