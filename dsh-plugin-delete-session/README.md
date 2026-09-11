# @yiln-dsh/dsh-plugin-delete-session

Adds permanent-delete actions to the current session and session rows in the DSH Web
GUI.

## Behavior

- Adds a trash icon beside the current session title.
- Adds a Delete session item to each ordinary session's three-dot menu and reuses the destructive confirmation dialog.
- Adds a batch-management control beside the New Workspace action; management mode exposes a checkbox on each visible ordinary session plus Cancel and Delete selected controls.
- Sends selected sessions through one serialized Host operation, so active sessions are flushed and disposed safely before their persisted logs are removed.
- Requires an explicit confirmation before sending the destructive request.
- Flushes and disposes an active session before deleting its persisted log.
- Deletes the subagent sessions delegated from the deleted session, at every
  depth, so no orphaned child transcript is left behind. Only sessions whose
  header records `origin: "subagent"` are followed: a session that merely names
  the deleted one as its fork parent stays untouched.
- Reports the cascaded ids in `subagentSessionIds`; a batch target already
  removed by an earlier cascade in the same request is acknowledged with
  `alreadyRemoved` instead of failing.
- Opens the next ordinary session when available, then reloads the browser session list so the deleted selection disappears.
- Deletes the guarded per-session directory, including temporary files placed there by session-scoped features; it does not delete the workspace directory or content-addressed image objects, which may be shared by other sessions.

The plugin supports the stock per-session JSONL persistence backend, including
every committed Session format generation (`session.jsonl` and
`session.vN.jsonl`, each optionally zstd-compressed). Backends such as SQLite
that do not expose a per-session artifact location return a clear
unsupported-backend error instead of issuing a broad database deletion.

The Host wrapper records `AgentHandle` values returned by the public agent
factory so an active Web session can be torn down in the correct order. A
session that was already live before this plugin mounted, and whose teardown
handle was not observed, is refused rather than having only its file removed.
Restart `dsh web` after installing the plugin so newly opened sessions are
tracked by the plugin.

## Install

The published package is `@yiln-dsh/dsh-plugin-delete-session@0.4.0`.

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-delete-session
```

The profile must be the `web` profile. Restart `dsh web` after installation.
