# dsh-plugin-web-daemon

A DSH plugin that manages the `dsh web` worker as a **real systemd unit**: the
plugin generates the unit file, maps the GUI buttons onto
`systemctl start/stop/restart/reset-failed`, and lets the Settings page edit
the few fields that matter.

Crash recovery (`Restart=always` — it keeps restarting unless explicitly
stopped with `systemctl stop`), boot autostart (`systemctl enable`),
and logs (journald) are handled by systemd itself — there is no built-in
child-process supervisor and no plugin-side restart logic.

## What it does

- Adds a **Web daemon** card under Settings > Plugins > Plugin configuration
  with live unit status (active state, PID, restart count) and
  Start/Stop/Restart/Reset buttons plus the editable fields.
- Generates `/etc/systemd/system/<unit>` (system scope, needs root) or
  `~/.config/systemd/user/<unit>` (`user` scope) on save/start.
- Exposes daemon state through `/_dsh/web-daemon/*` JSON routes.
- Registers the `web-daemon` settings namespace in the Host settings service
  (the card is keyed by that namespace on `settings.plugin.item`).
- The worker runs `dsh web --profile <profile> --no-open --port <port>` bound
  to loopback; LAN exposure is the job of `dsh-plugin-auth-webserver`.
- The unit gets `DSH_WEB_DAEMON_WORKER=1`; a daemonized GUI detects this and
  keeps only **Restart** available (e.g. to pick up plugin updates) — it asks
  systemd to restart its own unit, so the fresh process comes up even though
  the requesting one dies mid-request. Start/Stop and configuration stay with
  the unit owner's GUI.

## Install

From this checkout:

```bash
dsh plugin --profile web add file:/usr/local/src/project/dsh-plugin/dsh-plugin-web-daemon
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

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: systemd unit generation, systemctl actions, settings namespace, JSON API. |
| `lib/client.js` | Browser half: Settings plugin-configuration card (settings.plugin.item keyed by `web-daemon`) for daemon status and configuration. |
| `cordis.patch.yml` | Adds the host row and default configuration to the composed profile. |
