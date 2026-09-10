# dsh-plugins

A repository of plugins for DeepSeek Harness (DSH). Each plugin lives in its
own directory.

## Skills

| Skill | Purpose |
| --- | --- |
| [collective-deliberation](./skills/collective-deliberation) | Portable multi-agent proposals and peer scoring, mixed-model routing, deterministic thresholds, and evidence checks; includes an optional DSH workflow adapter. |
| [iterative-engineering-workflow](./skills/iterative-engineering-workflow) | Bounded planner/worker engineering loops with verification and selective escalation. |

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`@yiln-dsh/dsh-plugin-auth-webserver`](./dsh-plugin-auth-webserver) | Auth-gated reverse proxy with Host/Origin policy, HTTPS/TOTP, bounded sessions, WebSockets, and authenticated remote Settings/Models support. |
| [`@yiln-dsh/dsh-plugin-sandbox-guidance`](./dsh-plugin-sandbox-guidance) | Explain non-widening sandbox failures to the model and user without changing execution policy. |
| [`@yiln-dsh/dsh-plugin-file-explorer`](./dsh-plugin-file-explorer) | Contribute workspace Files and Git Graph pages to the right-panel host. |
| [`@yiln-dsh/dsh-plugin-right-panel`](./dsh-plugin-right-panel) | Fixed right-side page host with keyed Slots, icon rail, and overflow page menu. |
| [`@yiln-dsh/dsh-plugin-file-message`](./dsh-plugin-file-message) | Let the model send workspace-backed files and images into the conversation. |
| [`@yiln-dsh/dsh-plugin-llm-adapter`](./dsh-plugin-llm-adapter) | Fork the DSH pi-ai adapter with per-model reasoning/tier controls and reliable image request serialization. |
| [`@yiln-dsh/dsh-plugin-delete-session`](./dsh-plugin-delete-session) | Add confirmed permanent-delete actions for the current session, session-row menus, and selected session batches. |
| [`@yiln-dsh/dsh-plugin-web-daemon`](./dsh-plugin-web-daemon) | Manages `dsh web` as a real systemd unit, auto-resumes sessions that were running across restarts, shows server CPU/memory/network/filesystem status above New Session, and edits its configuration from the GUI Settings section. |
| [`@yiln-dsh/dsh-plugin-terminal-tab`](./dsh-plugin-terminal-tab) | Adds per-session persistent terminal tabs and a **新建终端** action to the Web GUI. |
| [`@yiln-dsh/dsh-plugin-web-browser`](./dsh-plugin-web-browser) | Server-side browser view next to the terminal: Chromium runs on the DSH host (playwright-core + CDP screencast), frames stream to the GUI, input is injected back, and a Chrome-style blank tab opens automatically. |
| [`@yiln-dsh/dsh-plugin-session-list-cache`](./dsh-plugin-session-list-cache) | Collapse the repeated full-store session enumerations the Web GUI fires concurrently, by caching and coalescing `sessionQuery.listSessions()` behind `/api/session/list` and `/api/subagents/list`. |
| [`@yiln-dsh/dsh-plugin-voice-input`](./dsh-plugin-voice-input) | Two-pass local voice input in the composer: a realtime model recognizes while you speak, a non-realtime model corrects the transcript after you stop. |

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
  dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.7.5.tgz
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
| `@yiln-dsh/dsh-plugin-auth-webserver` | `0.7.6` |
| `@yiln-dsh/dsh-plugin-sandbox-guidance` | `0.1.1` |
| `@yiln-dsh/dsh-plugin-file-explorer` | `0.9.0` |
| `@yiln-dsh/dsh-plugin-right-panel` | `0.1.2` |
| `@yiln-dsh/dsh-plugin-delete-session` | `0.3.0` |
| `@yiln-dsh/dsh-plugin-file-message` | `0.3.2` |
| `@yiln-dsh/dsh-plugin-llm-adapter` | `0.3.1` |
| `@yiln-dsh/dsh-plugin-web-daemon` | `0.7.1` |
| `@yiln-dsh/dsh-plugin-terminal-tab` | `0.1.8` |
| `@yiln-dsh/dsh-plugin-web-browser` | `0.1.2` |
| `@yiln-dsh/dsh-plugin-session-list-cache` | `0.1.0` |
| `@yiln-dsh/dsh-plugin-voice-input` | `0.1.1` |

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
  dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.7.5.tgz
  ```

- **Direct GitHub URL.** This works only when the repository root itself is the
  plugin package (a single-plugin repo). This repo keeps each plugin in a
  subdirectory and its root is not a `package.json`, so
  `github:user/repo#ref` installs a root package instead of a plugin here.
  If you want GitHub-only installs, publish each plugin as its own repository,
  or point `dependencies` at a plugin tarball URL.
