# @yiln-dsh/dsh-plugin-terminal-tab

A DSH Web bundle plugin that adds persistent shell terminals to each live
conversation session.

- Shows a `+` button inside the terminal tab bar for creating another terminal.
- Automatically names new terminals as `终端 1`, `终端 2`, and so on; double-click an existing tab to rename it.
- Shows a closing spinner and filters stale list responses while a terminal is being closed, so a fast click cannot resurrect the tab.
- Hides the conversation composer while the terminal view is active and restores
  it when the user returns to 对话 or 轨迹.
- Keeps the built-in 对话 / 轨迹 / 终端 view tabs in one conversation navigation row.
- Renders multiple shell tabs inside the terminal view with the actual
  `@xterm/xterm` terminal emulator. xterm.js owns ANSI rendering, scrollback,
  cursor, keyboard input and composition; there is no separate input bar.
- Each PTY tab opens its own WebSocket at `/_dsh/terminal-tab/ws`; xterm.js
  `onData` bytes flow to that socket and PTY output is written back with
  `terminal.write()`.
- The terminal content stays in the same center conversation area; it does not
  create a details column or a separate layout panel.
- A stale terminal id from a Host/client update is treated as an empty read,
  so polling cannot surface a terminal-ownership error after a hot reload.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host HTTP routes plus the `/_dsh/terminal-tab/ws` upgrade route, backed by `agents` and each Agent's scoped `subprocess.spawnTerminal` PTY primitive. |
| `client.js` | Browser bundle that loads `@xterm/xterm`, registers the terminal view and tab-bar `+` button, hides the composer while active, and binds one xterm.js instance to each WebSocket. |
| `cordis.patch.yml` | Web-profile composition patch for the Host row. |

## Install

The published package is `@yiln-dsh/dsh-plugin-terminal-tab@0.1.7`.

Local source directory:

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-terminal-tab
```

The plugin requires the web profile's built-in `subprocess.spawnTerminal` PTY
primitive and installs `@xterm/xterm` plus `ws` as runtime dependencies.
Restart `dsh web` after installing or changing the bundle composition.
