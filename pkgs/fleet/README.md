# fleet

One origin, many development boxes. Standalone package
[`@yiln-dsh/dsh-fleet`](../../docs/modules/fleet.md). Loader row: `fleet`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/fleet"
```

## Why a process per box

A box is one development target — the fleet host itself, or a remote machine
reached over SSH. Each box runs as its own `dsh --profile <name>` process.

It cannot be folded into one process: `fs`, `subprocess` and `sandbox` are
process-wide singletons, and the host plane is what consumes them. The Web file
browser (`api-workspace-files`, 20 `ctx.fs` calls), the session cwd
(`working-directory`), AGENTS.md loading (`agent-instructions`) and
`workspace-changes` are all **host rows**, so a preset-scoped provider realm
would leave them reading the wrong machine. One `ctx.fs` means one execution
world, and therefore one process per box.

## The three gateway invariants

Every box is served at `/<id>/` on one origin. Three details are load-bearing:

| Invariant | Why |
|---|---|
| Forward the original `Host` unchanged | The listener's Host/Origin fence compares the request authority with its trusted host. Rewriting `Host` to the loopback upstream yields `HTTP 403` and an endless `Reconnecting…` in the UI. Start the upstream with the fleet authority in `--trusted-host` instead. |
| Rewrite `Set-Cookie` `Path=/` to `Path=/<id>/` | dsh names its cookie `dsh-auth-<sha256(authority)>`. Behind one origin every box computes the **same** name, so with the stock `Path=/` the last login overwrites every other box and only one stays signed in. Distinct paths let the cookies coexist. |
| Proxy upgrades raw | The client opens a WebSocket for its remote multiplex. A normal HTTP proxy drops it and the UI never leaves "Reconnecting". |

## Coupling
The fleet takes **no required service**. Its gateway is a plain `node:http` listener
and its supervisor spawns child processes, so it activates with no web plugin
installed at all — verified by booting it on a bare Cordis root with no
`webServer` present, where the portal still answers `200`.

| Surface | Coupling |
|---|---|
| Management API | Optional runtime binding via `ctx.inject(['webServer'], …)`. Absent when no web server service exists; the gateway and supervisor keep working. |
| Generated profile bundles | `profileBundles` config, defaulting to the shipped web composition. Swapping the web plugin is a config change, never a code change. |
| Other feature modules | None. No import, and no reference to `auth-webserver`, `supervisor`, `git-graph`, `desktop-vnc` or `session-list-cache`. |

The one thing a swapped web plugin must still provide is the `--trusted-host`
fence behaviour: a box is reached at the gateway's external authority, so
`publicAuthority` must be set.

## Configure

```yaml
- id: fleet
  name: '@yiln-dsh/dsh-fleet'
  inject:
    - webServer
  config:
    gatewayPort: 8090        # portal + every /<id>/ prefix
    gatewayHost: 0.0.0.0
    registryPath: !!js dshHomePath('fleet/boxes.json')
    homeDir: !!js dshHomePath()
    binPath: dsh             # used to launch box processes
    portBase: 3101           # first port handed to a new box
    readyMs: 60000           # how long a box may take to listen
    autostart: false         # start enabled boxes when the fleet host starts
    # External authority browsers use for the gateway. Every box gets
    # --trusted-host <this>, or its /api answers 403 through the gateway.
    publicAuthority: 'gw.example.com'
    # Bundle layers for a generated box profile; point at your own list after
    # swapping the web plugin.
    profileBundles:
      - '@deepseek-ai/dsh-base'
      - '@deepseek-ai/dsh-web-app'
```

## Settings page

The client half registers one page under **Settings → Plugins** (`settings.plugins.tab`,
id `fleet`): the box table with live state, Start / Stop / Remove / Open, and the
create form (local or ssh). Every action goes through the management API below,
so the page keeps working with any web plugin that provides `webServer`.

The page reads `GET /_dsh/fleet/state`. Because that API is loopback-only, a
browser reaching the fleet host through a LAN bind without a local reverse proxy
sees the "unreachable" notice instead of a table — the API, not the page, is the
security boundary.

## Management API

Mounted on the fleet host's own GUI. Every route is **loopback-only**: it starts
processes, so exposing it on the LAN would be remote code execution.

| Route | Purpose |
|---|---|
| `GET  /_dsh/fleet/state` | boxes, ports, profiles, running state |
| `POST /_dsh/fleet/create` | create a box (port auto-allocated when omitted) |
| `POST /_dsh/fleet/start` | materialize its profile and start its process |
| `POST /_dsh/fleet/stop` | stop its process |
| `POST /_dsh/fleet/remove` | stop and forget a box |
| `POST /_dsh/fleet/patch` | read the generated profile patch |

A box record is `{ id, label?, kind, profile?, port?, workspace, ... }` where
`kind` is `local` or `ssh`. An `ssh` box additionally requires `sshHost`,
`sshNode`, `sshHelper` and `sshHelperHash` (the lowercase SHA-256 of the
installed helper entry). Unknown fields are rejected rather than dropped, so a
typo cannot be silently ignored in a hand-edited registry.

## Generated profiles

`$DSH_HOME/profiles/<profile>/` is written on demand, so `dsh --profile <name>`
works on it directly and an operator can repair it with the usual tooling.

- **local** — the shipped `dsh-base` + `dsh-web-app` composition, unchanged.
- **ssh** — the same composition with `fs`, `subprocess` and `sandbox` replaced
  by their SSH counterparts. The local rows are **disabled**, not renamed: an
  id-targeted patch that asserts a different `name` is skipped with a warning,
  which would silently leave the local provider mounted.

The SSH profile needs its provider packages installed
(`@deepseek-ai/dsh-ssh`, `-fs-ssh`, `-subprocess-ssh`, `-sandbox-ssh`). Install
them once per profile with `dsh plugin --profile <name> add …`; the four package
names are exported as `SSH_PROVIDER_PACKAGES`.

## Known limits

- **Sessions are per box.** Each box has its own `$DSH_HOME`-scoped session
  store, so a session belongs to exactly one execution world and cannot be
  resumed against the wrong filesystem. There is no unified cross-box list.
- **No cross-box agent messaging.** Subagent and agent-team backends are
  in-process only, so agents in different boxes cannot reach each other.
- **Memory is per box** — roughly 0.5–1.1 GB each.
- **Search tools need a remote `rg`.** `dsh-tool-fs-search` resolves the packaged
  ripgrep binary at a **local** absolute path and spawns it through the
  subprocess seam, so under an SSH box `glob`/`grep` fail with a ripgrep provider
  error unless the same binary exists at the same absolute path on the remote.
- **Protocol lockstep.** Client and remote helper must share a protocol version;
  upgrading dsh means upgrading every server's helper.
- **A dropped SSH transport is not replayed** — an interrupted mutation or
  launch can have an unknown outcome.
