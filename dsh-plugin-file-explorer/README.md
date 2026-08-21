# dsh-plugin-file-explorer

A DSH `dsh.bundle` that replaces the built-in **details** column of the Web
GUI with a workspace file explorer.

- Replaces the built-in tool-details right column while the bundle row is
  mounted (it is restored automatically when the plugin is disabled/removed).
- Auto-opens when a conversation (non-blank session) starts.
- Lists the active session's workspace directory, with folder navigation,
  editable path input, parent/refresh buttons, file and folder icons, and
  file sizes.
- File rows reveal view / download / delete buttons on hover; delete uses a
  second-click confirm.
- The column is a real layout column: it squeezes the conversation and its
  width can be dragged between 300–520px with the native splitter handle.
- The chosen width persists across sessions and page reloads (localStorage):
  the plugin captures the shell layout store actions when the root entry wires
  them, restores the saved width right after `openDetails()`, and saves the
  column width after every resizer drag.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: registers exact `/ _dsh/file-explorer/*` routes backed by the Host `fs`/`subprocess` services. |
| `client.js` | Client half: a static DSH client module registered into the `details` slot. |
| `cordis.patch.yml` | Composition patch that mounts the host row — declared with `inject: [webServer]`, so it activates only after the stock webserver service (`127.0.0.1`) is up. |

## Install

The plugin is version `0.1.0` from its own `package.json`.

### Local source directory

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-file-explorer
```

### Tarball

```bash
cd /path/to/dsh-plugin-file-explorer
pnpm pack
```

```bash
dsh plugin --profile web add ./dsh-plugin-file-explorer-0.1.0.tgz
```

### npm package

```bash
cd /path/to/dsh-plugin-file-explorer
npm publish
```

```bash
dsh plugin --profile web add dsh-plugin-file-explorer
```

The profile must be the `web` profile. The host row serves the API routes and
the client bundle loads with the web shell; restart `dsh web` after install to
apply the new profile composition.

## Behavior notes

- The Host falls back to `sandboxPolicy.workspaceRoot` when no path is passed,
  and returns `{ ok, path, parent, entries }` JSON — never live objects.
- `read` previews up to 256 KiB of UTF-8 text; `download` returns a base64
  data URL (64 MiB cap) that the browser triggers with `<a download>`.
- `delete` removes regular files (`rm -f`) and directories recursively
  (`rm -rf`); both are called only after a second-click confirm in the UI.
- Rows have a fixed 34px height, so the hover action swap never changes the
  row height; directories reveal a delete-only action set on hover.
- The browser module uses the `details` slot (scope: session), registering at
  priority `-6` to shadow the built-in tool-details occupant (priority `0`),
  the `layout` service (`openDetails` / `closeDetails`), the standard
  `useSessions` hook, and its own stylesheet.