# dsh-plugins

A repository of plugins for DeepSeek Harness (DSH). Each plugin lives in its
own directory.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`@yiln-dsh/dsh-plugin-auth-webserver`](./dsh-plugin-auth-webserver) | Auth-gated reverse proxy on every non-loopback NIC, forwarding to the stock `127.0.0.1:3080` web server, with optional TOTP 2FA. |
| [`@yiln-dsh/dsh-plugin-file-explorer`](./dsh-plugin-file-explorer) | Contribute workspace Files and Git Graph pages to the right-panel host. |
| [`@yiln-dsh/dsh-plugin-right-panel`](./dsh-plugin-right-panel) | Fixed right-side page host with keyed Slots, icon rail, and overflow page menu. |
| [`@yiln-dsh/dsh-plugin-file-message`](./dsh-plugin-file-message) | Let the model send workspace-backed files and images into the conversation. |
| [`@yiln-dsh/dsh-plugin-delete-session`](./dsh-plugin-delete-session) | Add a confirmed permanent-delete action for the current session. |
| [`@yiln-dsh/dsh-plugin-web-daemon`](./dsh-plugin-web-daemon) | Manages `dsh web` as a real systemd unit, auto-resumes sessions that were running across restarts, shows server CPU/memory/network status above New Session, and edits its configuration from the GUI Settings section. |
| [`@yiln-dsh/dsh-plugin-terminal-tab`](./dsh-plugin-terminal-tab) | Adds per-session persistent terminal tabs and a **新建终端** action to the Web GUI. |

## Install

Each package is installed per-profile. Replace `<path-or-spec>` with one of the
formats below.

```bash
dsh plugin --profile web add <path-or-spec>
```

Supported install formats:

- **Source directory.** Clone or download the repo, then point DSH at one
  plugin directory:

  ```bash
  dsh plugin --profile web add /path/to/dsh-plugin-auth-webserver
  ```

- **Tarball.** Pack one plugin directory, then install the `.tgz`:

  ```bash
  cd /path/to/dsh-plugin-auth-webserver && pnpm pack
  dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.3.0.tgz
  ```

- **npm package.** Publish one plugin directory, then install by name:

  ```bash
  cd /path/to/dsh-plugin-auth-webserver && npm publish --access public
  dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
  ```

- **Direct GitHub URL.** Works only when the GitHub repository root is the
  plugin package itself:

  ```bash
  dsh plugin --profile web add github:<owner>/<plugin-repo>#<commit-sha>
  ```

## Versioning

The published bundle plugins in the `yiln-dsh` organization currently use:

| Package | Version |
| --- | --- |
| `@yiln-dsh/dsh-plugin-auth-webserver` | `0.3.0` |
| `@yiln-dsh/dsh-plugin-file-explorer` | `0.5.0` |
| `@yiln-dsh/dsh-plugin-right-panel` | `0.1.0` |
| `@yiln-dsh/dsh-plugin-delete-session` | `0.1.1` |
| `@yiln-dsh/dsh-plugin-file-message` | `0.1.0` |
| `@yiln-dsh/dsh-plugin-web-daemon` | `0.5.8` |
| `@yiln-dsh/dsh-plugin-terminal-tab` | `0.1.5` |

Each plugin's version is the `version` field in its own `package.json`.
Semantic versioning is recommended: patch for fixes, minor for additive
features, major for breaking changes.

The version controls npm ranges, tarball file names, and package metadata.
A `file:` source install uses the source tree as-is. A direct GitHub install
is pinned by the commit or branch after `#`, not by `package.json` alone.

## Distributing a plugin

`dsh plugin` forwards pnpm dependency specs, so a plugin in this repo can be
shared three ways:

- **npm package (recommended).** Publish one plugin directory, then install by
  name:

  ```bash
  cd dsh-plugin-auth-webserver && npm publish
  dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
  ```

- **Tarball.** Pack one plugin directory and hand out the `.tgz`:

  ```bash
  cd dsh-plugin-auth-webserver && pnpm pack
  dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.3.0.tgz
  ```

- **Direct GitHub URL.** This works only when the repository root itself is the
  plugin package (a single-plugin repo). This repo keeps each plugin in a
  subdirectory and its root is not a `package.json`, so
  `github:user/repo#ref` installs a root package instead of a plugin here.
  If you want GitHub-only installs, publish each plugin as its own repository,
  or point `dependencies` at a plugin tarball URL.
