# DSH Compatibility

This repository targets the DSH Web bundle, not only the `@deepseek-ai/dsh` CLI
package. Compatibility is checked against the exact DSH packages each plugin
injects and the Cordis services and Slots its Host and Client halves use.

## Packages

Seven packages install independently; there is no aggregate package. All are
verified against DSH `0.2.2-rc.1`.

| Package | Verified injections |
| --- | --- |
| `gateway` | `webServer`, `settings`, `fs`, `sandboxPolicy`, `agents`, `sessionController`, `workspaceRegistry`, `sessionQuery`, `tools` |
| `supervisor` | `webServer`, `settings` |
| `delete-session` | `slots`, `sessions` |
| `git-graph` | `slots`, `locale`, `sidebarRight`, `sidebarRightTabs`, `remote`, `remote.session` |
| `browser-vnc` (row `dsh-desktop-vnc`) | `slots`, `locale`, `sidebarRightTabs`, `connection` |
| `session-list-cache` | `sessions` |
| `code-server` (row `dsh-code-server`) | Host: `webServer`, `subprocess`. Client: `slots`, `locale`, `sidebarRightTabs` |

`delegate-mode`, `tool-restrict-presets`, `tool-visibility`, `auth-webserver` and
`fleet` are gone. The Host ships `dsh-authorization`, and `gateway` replaces the
SSH fleet model with a reverse tunnel.

## Version window

Every package declares `engines.dsh` as `>=0.2.1-0 <0.3.0-0`. DSH reads an own
`engines.dsh` alone, ignores `peerDependencies` entirely, and evaluates the range
with `includePrerelease: true`. The prerelease markers are therefore load-bearing:

- The lower bound is `0.2.1-0`, not `0.2.1`. npm never published a stable `0.2.1`;
  the line exists only as `0.2.1-alpha.*` and `0.2.1-rc.*`. Plain `>=0.2.1` sorts
  `0.2.1-rc.3` below `0.2.1` and would deny every package on the verified runtime.
- The upper bound is `<0.3.0-0`, not `<0.3.0`. Prereleases sort below `0.3.0`, so
  `<0.3.0` would admit the whole 0.3.0 prerelease line, which this suite has never
  run against.

The window states which runtimes the suite is willing to load into. It is not a
per-release certification.

## Compatibility seams

These are the interfaces the suite depends on. A change to any of them is a
breaking change for at least one package.

| Seam | Used by | What breaks if it moves |
| --- | --- | --- |
| `webServer.register` with `kind: 'prefix'` | gateway, browser-vnc, code-server | Subpath proxying and asset serving |
| `webServer.registerUpgrade` (exact pathname, no prefix form) | browser-vnc, code-server | Every plugin WebSocket |
| `sidebar.right.pane.tab` seat (`scope: session`, gives `sessionId` + `useSessions` + `useWorkspaces`) | browser-vnc, code-server, git-graph | Right-sidebar page bodies |
| `sidebarRightTabs.register` | browser-vnc, code-server | Tab kinds and their guide entries |
| `subprocess.spawn` / `resolveExecutable` | code-server | Starting and detecting the editor |
| `session/disposed` | browser-vnc, session-list-cache | Instance and cache cleanup |
| `sessions` | delete-session, session-list-cache | Session enumeration and deletion |
| `settings` + `sandboxPolicy` | gateway, supervisor | Profile and unit management |

## code-server specifics

Two upstream behaviours are worth recording, because both were measured rather
than assumed:

- The workbench socket path is `<prefix>/stable-<commit>`. `patches/base-path.diff`
  appends only the versioned server root, not the deeper workbench directory. The
  Host's upgrade table is an exact-path map, so the path is probed from the
  instance's own page and registered explicitly.
- `code-server --version` prints a first-run `info Wrote default config file…`
  line before the version, so the version is matched by shape, not by first line.

## Not covered

`code-server` ships from GitHub, not npm, and the plugin does not bundle the
binary. A host without `code-server` gets the guided install page. Rendering of a
real VS Code workbench and its WebSocket has been verified on one live profile
against code-server `4.145.0`; other versions are untested.
