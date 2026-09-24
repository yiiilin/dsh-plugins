# @yiln-dsh/dsh-plugin-web-daemon

A DSH plugin that manages the `dsh web` worker as a **real systemd unit** and adds a compact server-health monitor to the sidebar footer, above the Settings action. The plugin generates the unit file, maps the GUI buttons onto
`systemctl start/stop/restart/reset-failed`, and lets the Settings page edit
the few fields that matter. It also keeps a durable registry of the sessions
attached to the daemon — and of the subagents they were running — so that both
come back after a process restart.

Crash recovery (`Restart=always` — it keeps restarting unless explicitly
stopped with `systemctl stop`), boot autostart (`systemctl enable`), and logs
(journald) are handled by systemd itself. Session recovery is handled by the
plugin's registry at `$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json`:
attached agents are recorded atomically with their live status — every top-level
session, plus every running subagent child under the `parentSession` it belongs
to. Only records marked `running: true` are resumed after the next daemon start;
idle sessions are removed from the registry. A final turn terminated by a
daemon shutdown is explicitly queued once for continuation after the Agent is
restored, for a top-level session and for each running child alike. The registry stores only
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
- Adds a compact **Server status** panel to the official `sidebar.footer.action`
  Slot above the Settings action, with live CPU percentage, memory percentage,
  network download/upload rates, and mounted physical block-backed filesystem
  usage (device, mount point, used/total bytes, and percentage). The panel grows
  with the number of disk rows and collapses to a status dot with the sidebar
  rail.
- Exposes daemon state through `/_dsh/web-daemon/*` JSON routes and server metrics through `/_dsh/web-daemon/metrics`.
- Disk metrics list local block-backed filesystems visible to the worker and mounted in its namespace; virtual, network, overlay, loop, and zram filesystems are omitted. Unmounted disks cannot report filesystem occupancy. Byte counters are returned as decimal strings for large-volume precision.
- Records sessions and their live status in `$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json` — every top-level session, and every running subagent child as `{origin: "subagent", parentSession}`. Only records marked `running: true` are resumed; idle sessions are not started just because they have a transcript.

A record is only discarded when its session is genuinely gone: if the persistence listing does not surface a recorded session, the plugin asks the backend directly (`sessionPersistence.inspect`) before pruning, so a session that exists on disk is resumed even when the listing omits it (as happened after the DSH 0.1.5 upgrade, where the concrete persistence backend moved). Persisted sessions that were deleted are pruned.
- A resumed session restores its transcript and Agent. If the previous process stopped while the session was marked running, the plugin queues one internal recovery notice to continue it. Tool calls marked as unknown are explicitly left for the model to verify before retrying.
- A running subagent child is re-attached to its parent with the same continuation notice, because a restart kills the child too and its in-flight turn is just as interrupted as its parent's. See [Subagent recovery](#subagent-recovery) for what that path can and cannot restore.
- Registers the `web-daemon` settings namespace in the Host settings service
  (the card is keyed by that namespace on both the legacy `settings.plugin.item` slot and the newer `plugins.item` slot).
- The worker runs `dsh web --profile <profile> --no-open --port <port>` bound
  to loopback; LAN exposure is the job of `@yiln-dsh/dsh-plugin-auth-webserver`.
  Writing `startCommand` replaces that whole line, so the unit runs exactly the
  command the operator wrote.
- The unit gets `DSH_WEB_DAEMON_WORKER=1`; a daemonized GUI detects this and
  keeps only **Restart** available (e.g. to pick up plugin updates) — it asks
  systemd to restart its own unit, so the fresh process comes up even though
  the requesting one dies mid-request. Start/Stop and configuration stay with
  the unit owner's GUI.
- On a Linux worker without `DISPLAY`/`WAYLAND_DISPLAY` (and not WSL), the
  plugin guards the RC1 `session.openWorkspacePath` Host service and retains
  the legacy `/api/host.openPath` and `/api/host.openTextFile` guards for older
  clients. It returns a structured message directing users to the file
  explorer preview or download instead of leaking a native `xdg-open` failure
  into the GUI.

## Install

The published package is `@yiln-dsh/dsh-plugin-web-daemon@0.8.2`.

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
There are six fields:

- `enabled`: maps to `systemctl enable/disable` plus start on boot.
- `systemdScope`: `system` or `user`.
- `systemdUnit`: unit file name (default `dsh-web.service`).
- `profile`: DSH profile the worker runs.
- `port`: worker listen port on loopback.
- `startCommand`: the unit's whole `ExecStart=` line, written by hand.

`startCommand` is the escape hatch for what the fixed fields cannot express — a
wrapper script, extra flags, a different launcher. Left empty (the default), the
plugin generates `dsh web --profile <profile> --no-open --port <port>`. A written
line is used verbatim: the plugin adds no quoting and rewrites nothing, so the
operator's own quoting is exactly what systemd parses. It must stay on one line —
a newline would end `ExecStart=` and let the rest act as another unit directive,
so such a save is refused with that reason — and its first word must be an
executable systemd can find (an absolute path is safest). While a command is
written, `profile` and `port` only serve as the values an empty field falls back
to, and the card greys them out. The `Environment=` lines
(`DSH_WEB_DAEMON_WORKER=1`, `DSH_HOME`, `HOME`, `PATH`) are still injected around
whatever command is written, so a wrapper that still launches `dsh web` keeps
owning the session registry and session recovery.

Everything else is intentionally fixed: `Restart=always` with
`RestartSec=2`, start-rate limiting left to systemd's defaults, logs in the
journal (`journalctl -u <unit> -f`). Saving rewrites the unit, reloads the
daemon, and restarts the worker if it was running.

The unit is regenerated on every save *and* on every boot of any process that
composes the plugin row, because the generated `ExecStart` embeds the absolute
interpreter path this process runs under — an nvm node upgrade would otherwise
leave a unit that systemd rejects with `203/EXEC`. Writing `startCommand` replaces
that path with whatever the operator wrote, so keeping such a unit working across
an upgrade is the operator's own concern.

## Session recovery

The registry lives at
`$DSH_HOME/plugins/dsh-plugin-web-daemon/active-sessions.json` and stores one
record per attached agent together with its live status:

```json
{
  "version": 1,
  "updatedAt": "2026-08-27T03:22:27.680Z",
  "sessions": [
    { "sessionId": "session-…", "running": true, "cwd": "/path", "agentPreset": "yiln", "agentOptions": { "provider": "…", "model": "…", "maxTokens": 128000 } },
    { "sessionId": "1fa60ce8-…", "origin": "subagent", "parentSession": "session-…", "running": true, "cwd": "/path" }
  ]
}
```

A top-level record carries the session identity, its workspace, and the preset
and model options to rebuild it. A child record carries only its lineage: a
child is re-attached from its own persisted descriptor, so recording the
parent's route here would restore the wrong model.

Recorded state is the single source of truth:

- `agent/status = running` adds or refreshes the record; `idle` or an explicit
  disposal removes it. Children are tracked the same way — `agents.roots()` is
  top-level only, so the snapshot walks `agents.list()` to see them at all.
- On `SIGTERM` / `SIGINT` the plugin snapshots every Agent that is still
  `running` before the process exits, so `systemctl restart` keeps the exact
  set that was live.
- On startup the systemd worker (`DSH_WEB_DAEMON_WORKER=1` — the only process
  that owns the registry) loads the file and resumes each `running: true`
  record: the Agent is rebuilt with the recorded `agentPreset` and the model
  options the session was **actually using before the restart** — taken from
  the session log's latest `request/header`, not the creation-time snapshot
  stored in the registry — and one internal recovery notice is queued so the
  model continues the interrupted task instead of sitting idle.
- Legacy records without a `running` field are migrated once: they are resumed
  only when the persisted log ends in an interrupted/disposed turn.
- A foreground owner sharing `DSH_HOME` never resumes; `active-sessions.lock`
  (pid + boot identity + token) prevents two workers from racing.
- While recovery is in progress, Host calls that would create or wake an Agent
  (`session.prompt`, `session.page`, `session.follow`, `session.modelCatalog`, …) and every
  goal mutation (`create`, `edit`, `pause`, `resume`, `complete`, `clear`) wait behind the
  same barrier, so an auto-reconnecting browser cannot claim a session before
  resume.
- The barrier only defers calls until recovery settles; afterwards each wrapped
  method is called straight through, so the synchronous goal service keeps
  throwing synchronously for its callers (the goal tools and slash commands
  catch `GoalError` with a plain `try`/`catch`). A deferred `GoalError` is also
  kept handled, because an unhandled rejection makes the Harness's fail-loud
  handler exit the daemon and stop every hosted session.
- Stored sessions are resolved through the RC1 `sessionPersistence` vocabulary:
  `list()` returns snapshots (`{ header, revision, sizeBytes }`), `stat(id)`
  resolves one, and the event log comes from `open(id, 'read')`.
  `lib/stored-sessions.js` normalizes those shapes in one place, because reading
  a snapshot as a header yields `id === undefined` for every session and prunes
  every record as "removed-not-persisted" — a restart would then resume nothing.

Each boot writes `recovery-diagnostics.json` next to the registry, recording
the lock result, every session's decision, and the API calls the gate held:

```bash
cat "$DSH_HOME/plugins/dsh-plugin-web-daemon/recovery-diagnostics.json"
journalctl -u dsh-web.service -f   # look for "resumed session …"
```

The decisions are `resumed`, `resumed-child`, `resumed-parent`,
`skipped-already-live`, `skipped-not-running`, `skipped-not-resumable`,
`skipped-parent-unavailable`, `skipped-foreign-child`,
`skipped-subagents-unavailable`, `skipped-delivery-unavailable`,
`skipped-projections-unavailable`, `skipped-invalid-time-zone`,
`skipped-attachment-invalid`, `failed` and `failed-parent`, each optionally
carrying the error that produced it, plus the `removed-*` set that marks a
registry record dropped as unresumable (`removed-not-persisted`,
`removed-subagent`, `removed-no-continuation`). The `skipped-*` list is
authoritative in `lib/subagent-recovery.js` rather than here: a decision added
there without a matching line in this table is a docs bug, not a missing case.

## Subagent recovery

A restart kills the subagent children a session had running, and they do not
come back on their own: the core re-attaches a child only when a message is
delivered to it by its **exact live direct parent**. Recovery therefore runs in
two phases — the recorded top-level sessions are resumed first, then every
recorded child is re-attached, one generation at a time, because a nested child
becomes deliverable only after its own parent is back.

Re-attachment goes through `subagents.prompt({parentSessionId, childSessionId,
mode: "continuable", delivery: "queue"})`, which cold-resumes an absent child
from its own persisted `subagent/descriptor` and submits the continuation notice
as a distinct turn. The plugin never creates a child Agent itself: a child
raised outside the subagent manager would be live but unreachable, because the
manager's resident map owns inbox admission and parent/child routing — and a
second delivery would then try to resume an already-owned session.

Two cases need more than the registry:

- **The parent was idle while its child kept running.** A background child
  outlives its parent's turn, so the parent can have no record of its own.
  Recovery resumes such a parent on demand — without a continuation notice,
  because it was not interrupted — and then re-attaches the child. The child's
  settlement notice is what wakes it, exactly as it would have before the
  restart.
- **The parent is itself a child.** Deeper nesting is restored generation by
  generation. A nested parent that was *idle* at shutdown exists only as
  lineage, so its children stay cold and are reported as
  `skipped-parent-unavailable` instead of waking it with a spurious turn.

Refusals are classified rather than retried blindly: a one-shot child is
permanently non-resumable (`skipped-not-resumable`), a child whose persisted
lineage no longer matches its recorded parent is `skipped-foreign-child`, and
only a transient `delivery-unavailable` keeps its record for the next restart.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: systemd unit generation, session registry and resume lifecycle, CPU/memory/network/filesystem metrics sampling, settings namespace, JSON API, and headless workspace-open protection. |
| `lib/recovery-gate.js` | The recovery barrier: defers session and goal calls until resume finishes, then restores each service's own synchronous calling convention. |
| `lib/stored-sessions.js` | RC1 `sessionPersistence` adapter: normalizes `list()` snapshots and reads one stored session's header plus event log for recovery. |
| `lib/subagent-recovery.js` | Child-session records and the re-attachment request: lineage-only records, their validation, the `subagents.prompt` queue request, and the refusal classification. |
| `lib/client.js` | Browser half: server status panel in the sidebar footer above the Settings action, plus the Settings plugin-configuration card. |
| `cordis.patch.yml` | Adds the host row and default configuration to the composed profile. |
