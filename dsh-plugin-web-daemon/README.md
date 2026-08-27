# @yiln-dsh/dsh-plugin-web-daemon

A DSH plugin that manages the `dsh web` worker as a **real systemd unit** and adds a compact server-health monitor above the New Session button. The plugin generates the unit file, maps the GUI buttons onto
`systemctl start/stop/restart/reset-failed`, and lets the Settings page edit
the few fields that matter. It also keeps a durable registry of top-level
sessions attached to the daemon so they can be resumed after a process restart.

Crash recovery (`Restart=always` — it keeps restarting unless explicitly
stopped with `systemctl stop`), boot autostart (`systemctl enable`), and logs
(journald) are handled by systemd itself. Session recovery is handled by the
plugin's registry at `$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json`:
attached top-level agents are recorded atomically with their live status. Only
records marked `running: true` are resumed after the next daemon start; idle
sessions are removed from the registry. A final turn terminated by a
daemon shutdown is explicitly queued once for continuation after the Agent is
restored. The registry stores only
session identity, workspace, preset, and model options; it contains no
credentials. Only the managed systemd worker (`DSH_WEB_DAEMON_WORKER=1`)
owns this registry; a foreground owner sharing the same `DSH_HOME` never
resumes the same identity. A small `active-sessions.lock` lease beside the
registry prevents two managed workers from resuming the same session. A
normal shutdown keeps the records for the next start, while an explicitly
disposed session is removed.

## What it does

- Adds a **Web daemon** card under Settings > Plugins > Plugin configuration
  with live unit status (active state, PID, restart count) and
  Start/Stop/Restart/Reset buttons plus the editable fields.
- Generates `/etc/systemd/system/<unit>` (system scope, needs root) or
  `~/.config/systemd/user/<unit>` (`user` scope) on save/start.
- Adds a compact **Server status** panel above New Session with live CPU percentage, memory percentage, and network download/upload rates. The panel collapses to a status dot with the sidebar rail.
- Exposes daemon state through `/_dsh/web-daemon/*` JSON routes and server metrics through `/_dsh/web-daemon/metrics`.
- Records top-level sessions and their live status in `$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json`. Only sessions recorded with `running: true` are resumed; idle sessions are not started just because they have a transcript. Persisted sessions that were deleted are pruned; subagent sessions are intentionally excluded.
- A resumed session restores its transcript and Agent. If the previous process stopped while the session was marked running, the plugin queues one internal recovery notice to continue it. Tool calls marked as unknown are explicitly left for the model to verify before retrying.
- Registers the `web-daemon` settings namespace in the Host settings service
  (the card is keyed by that namespace on `settings.plugin.item`).
- The worker runs `dsh web --profile <profile> --no-open --port <port>` bound
  to loopback; LAN exposure is the job of `@yiln-dsh/dsh-plugin-auth-webserver`.
- The unit gets `DSH_WEB_DAEMON_WORKER=1`; a daemonized GUI detects this and
  keeps only **Restart** available (e.g. to pick up plugin updates) — it asks
  systemd to restart its own unit, so the fresh process comes up even though
  the requesting one dies mid-request. Start/Stop and configuration stay with
  the unit owner's GUI.
- On a Linux worker without `DISPLAY`/`WAYLAND_DISPLAY` (and not WSL), the
  plugin owns the `/api/host.openPath` and `/api/host.openTextFile` guard. It
  returns a structured message directing users to the file explorer preview or
  download instead of leaking a native `xdg-open` failure into the GUI.

## Install

The published package is `@yiln-dsh/dsh-plugin-web-daemon@0.5.8`.

### npm package

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-web-daemon@latest
```

The package is a dual-face plugin: its host row talks to systemd and its
`dsh.client` export registers the Settings plugin-configuration card. Client
module changes need a page refresh; the running `dsh web` process does need to
be restarted once so the host row is composed into the profile.

## Configure

Open **Settings > Plugins > Plugin configuration > Web daemon** in the GUI.
There are five fields:

- `enabled`: maps to `systemctl enable/disable` plus start on boot.
- `systemdScope`: `system` or `user`.
- `systemdUnit`: unit file name (default `dsh-web.service`).
- `profile`: DSH profile the worker runs.
- `port`: worker listen port on loopback.

Everything else is intentionally fixed: `Restart=always` with
`RestartSec=2`, start-rate limiting left to systemd's defaults, logs in the
journal (`journalctl -u <unit> -f`). Saving rewrites the unit, reloads the
daemon, and restarts the worker if it was running.

## Session recovery

The registry lives at
`$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json` and stores one
record per top-level session together with its live status:

```json
{
  "version": 1,
  "updatedAt": "2026-08-27T03:22:27.680Z",
  "sessions": [
    { "sessionId": "session-…", "running": true, "cwd": "/path", "agentPreset": "yiln", "agentOptions": { "provider": "…", "model": "…", "maxTokens": 128000 } }
  ]
}
```

Recorded state is the single source of truth:

- `agent/status = running` adds or refreshes the record; `idle` or an explicit
  disposal removes it.
- On `SIGTERM` / `SIGINT` the plugin snapshots every Agent that is still
  `running` before the process exits, so `systemctl restart` keeps the exact
  set that was live.
- On startup the systemd worker (`DSH_WEB_DAEMON_WORKER=1` — the only process
  that owns the registry) loads the file and resumes each `running: true`
  record: the Agent is rebuilt with the recorded `agentOptions` and
  `agentPreset`, and one internal recovery notice is queued so the model
  continues the interrupted task instead of sitting idle.
- Legacy records without a `running` field are migrated once: they are resumed
  only when the persisted log ends in an interrupted/disposed turn.
- A foreground owner sharing `DSH_HOME` never resumes; `active-sessions.lock`
  (pid + boot identity + token) prevents two workers from racing.
- While recovery is in progress, Host API calls that would create or wake an
  Agent (`session.prompt`, `session.models`, …) wait behind the same barrier,
  so an auto-reconnecting browser cannot claim a session before resume.

Each boot writes `recovery-diagnostics.json` next to the registry, recording
the lock result, every session's decision (`resumed` / `skipped-already-live` /
`skipped-not-running` / `failed` + error), and the API calls the gate held:

```bash
cat "$DSH_HOME/plugins/dsh-plugin-web-daemon/recovery-diagnostics.json"
journalctl -u dsh-web.service -f   # look for "resumed session …"
```

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: systemd unit generation, session registry and resume lifecycle, system metrics sampling, settings namespace, JSON API, and the sidebar client-bundle patch. |
| `lib/client.js` | Browser half: server status panel above New Session plus the Settings plugin-configuration card. |
| `cordis.patch.yml` | Adds the host row and default configuration to the composed profile. |
