# dsh-plugin-web-daemon

A DSH plugin that supervises a `dsh web` worker process with two modes:

- **Child process** — the plugin spawns the worker and supervises it directly
  with a systemd-style lifecycle: restart policy, start-limit window, PID file,
  persistent log. The worker dies with the GUI process.
- **systemd unit** — the plugin generates and manages a real systemd unit for
  the worker: boot autostart (`systemctl enable`), crash recovery
  (`Restart=`), and the unit keeps running even when the GUI process exits.

The browser settings page can switch modes and edit the worker
configuration without restarting the GUI.

## What it does

- Adds a Settings section named **Web daemon**.
- Exposes daemon state and controls through `/_dsh/web-daemon/*` JSON routes.
- Registers the `web-daemon` settings namespace in the Host settings service.
- Spawns the worker with the same DSH installation by default, passing
  `DSH_WEB_DAEMON_WORKER=1` so a worker does not recursively supervise itself.
- Writes the worker PID to `$DSH_HOME/run/web-daemon.pid` and stdout/stderr to
  the `$DSH_HOME/logs/web-daemon` log file.

## Install

From this checkout:

```bash
dsh plugin --profile web add file:/usr/local/src/project/dsh-plugin/dsh-plugin-web-daemon
```

The package is a dual-face plugin: its host row supervises the worker and its
`dsh.client` export registers the Settings section. Client module changes need
a page refresh; the running `dsh web` process does need to be restarted once so
the host row is composed into the profile.

## Configure

Open **Settings > Web daemon** in the GUI. The notable fields are:

- `enabled`: auto-start the managed worker when the plugin is mounted.
- `supervisor`: `child` (plugin-managed) or `systemd` (real systemd unit).
- `systemdUnit`, `systemdScope`: unit file name and `system`/`user` scope
  (system scope needs root; unit files land in
  `/etc/systemd/system/<unit>` or `~/.config/systemd/user/<unit>`).
- `profile`, `host`, `port`, `noOpen`, `trustedHosts`.
- `restart`: `no`, `on-failure`, or `always` (mapped to systemd `Restart=`).
- `restartSec`, `startLimitIntervalSec`, `startLimitBurst`.
- `extraArgs`, `environment`, `workingDirectory`, `logDir`, `pidFile`.

In systemd mode the Start/Stop/Restart/Reset buttons map to
`systemctl start/stop/restart/reset-failed` on the generated unit, and
`enabled` maps to `systemctl enable/disable`. The unit is written on start and
removed when the supervisor is switched back to `child`.

`host: 0.0.0.0` is intentionally omitted from the CLI flags because the stock
`dsh web` parser rejects it. Deployments using `dsh-plugin-auth-webserver` can
still bind to `0.0.0.0` through that plugin's own webserver layer.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: worker supervisor (child + systemd), settings namespace, JSON API. |
| `lib/client.js` | Browser half: Settings section for daemon status and configuration. |
| `cordis.patch.yml` | Adds the host row and default configuration to the composed profile. |