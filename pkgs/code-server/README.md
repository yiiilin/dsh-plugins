# @yiln-dsh/dsh-code-server

Standalone DeepSeek Harness plugin. It adds a **Code editor** tab to the right
sidebar that embeds a host-installed
[code-server](https://github.com/coder/code-server) (VS Code in the browser),
**one process per DSH Workspace**. Opening the tab starts that workspace's
editor automatically and opens the workspace folder; all sessions in the same
workspace share one editor and one extensions directory. Installs on its own;
it declares one `dsh.bundle` layer and mounts a single Loader row
(`dsh-code-server`).

```bash
dsh plugin --profile <p> add "github:<owner>/<repo>#path:/pkgs/code-server"
```

See [the module notes](../../docs/modules/code-server.md) for the route
contract, configuration and verification.

## What it does

- **Detects** `code-server` on the host with `subprocess.resolveExecutable`,
  and runs `--version` for the panel's status line. The plugin does **not**
  bundle code-server, and it does not install anything by itself.
- When the binary is missing, the tab shows a **setup guide**: the configured
  install command, a copy button, a confirmed one-click install, a re-detect
  button, and the install output. The install command comes only from plugin
  configuration, never from a browser request.
- When it is present, opening the tab **automatically starts** one loopback
  code-server for the current DSH Workspace and shows it in an iframe with
  `?folder=<workspace.path>`, so VS Code opens that workspace immediately.
  Sessions in the same workspace reuse the instance; it is released by the
  panel's close button, an explicit `DELETE`, or plugin unload — **not** by
  `session/disposed`, because other sessions may still be using it.
- All instances share one `--extensions-dir`, so VS Code extensions are
  installed once instead of once per workspace. `user-data-dir` (settings,
  workspaceStorage) stays per-workspace to avoid concurrent writes.

## VS Code extensions

code-server supports VS Code extensions (Extensions sidebar,
`--install-extension`, VSIX, `--list-extensions`), with two caveats:

- The marketplace is [Open VSX](https://open-vsx.org), **not** Microsoft's.
  Microsoft's ToS forbids non-Microsoft VS Code builds from using its marketplace,
  so closed-source extensions such as Live Share and Remote-SSH / Containers /
  WSL are unavailable. `$EXTENSIONS_GALLERY` can point at a private gallery.
- Several instances sharing one extensions directory is safe for **reads**, but
  concurrent install/uninstall writes the same directory (`.obsolete`, unpacking).
  Prefer installing while no instance is running:
  `code-server --install-extension <id> --extensions-dir <stateDir>/extensions`.

## Security boundary

Each child is launched with `--auth none` and `--bind-addr 127.0.0.1:<port>`.
That is only safe because the **Harness's already-authenticated** web server is
the sole reverse proxy to that port. Do not expose an instance port on a LAN
interface, and do not put this plugin behind a proxy that forwards arbitrary
hosts to the loopback port: either would turn it into unauthenticated remote
code execution. State-changing routes additionally refuse a foreign `Origin`.

The proxy rewrites `Host` and `Origin` together (code-server compares them),
scopes `Set-Cookie: Path=/` to the instance prefix, keeps relative redirects
inside that prefix, and drops `Service-Worker-Allowed` so code-server's service
worker cannot claim the whole Harness origin.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Mount the routes but refuse to start instances. |
| `executable` | `code-server` | Command name or absolute path on the host. |
| `installCommand` | `["npm","install","-g","--loglevel=http","code-server"]` | argv for the install; no shell. `--loglevel=http` keeps npm printing progress (it is silent without a TTY, which made a 3-minute install look frozen). |
| `portRange` | `[14000, 14099]` | Inclusive loopback port pool, one port per instance. |
| `extraArgs` | `[]` | Extra arguments appended to each launch. |
| `stateDir` | `dshHomePath('code-server')` | Root of per-workspace `user-data` / `config.yaml` and the shared extensions dir. |
| `extensionsDir` | `''` | Shared `--extensions-dir`; empty means `<stateDir>/extensions`. |
| `startupTimeoutMs` | `30000` | Deadline for a child to bind its port. |
| `installTimeoutMs` | `300000` | Deadline for the guided install. |

Per-workspace directories are named from a hash of the workspace id and are
**reused**, so settings survive a restart. They are not deleted when an instance
closes. The shared extensions directory is never deleted.

## Verification

```bash
npm run check
npm test
```

A live check needs an isolated DSH profile with code-server installed on that
host: install the package there, restart the daemon, open the sidebar tab, and
confirm the workbench loads and its WebSocket connects. `npm run check` and
`npm test` verify the mounting contract, the proxy header rewrites, the
instance lifecycle and the Client helpers; they do not prove that a real VS
Code workbench renders.
