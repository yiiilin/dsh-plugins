# @yiln-dsh/dsh-plugin-file-explorer

A DSH `dsh.bundle` that contributes a workspace file explorer page to the
`@yiln-dsh/dsh-plugin-right-panel` host.

- Registers two independent right-panel pages: **Files** and **Git Graph**. The
  host owns the right-column layout, navigation rail, width, and collapse
  behavior.
- **Files** page: lists the active session's workspace directory, with folder
  navigation, editable path input, parent/refresh buttons, file and folder
  icons, and file sizes. File rows reveal view / download / delete buttons on
  hover; delete uses a second-click confirm. Image View supports fullscreen,
  25%-400% zoom, wheel zoom, and drag-to-pan after zooming.
- **Git Graph** page: a vscode/le-git-graph style commit graph rendered from
  the repository containing the current directory —
  - colored lane graph with commit dots and merge curves (all branches or the
    current branch, refreshable),
  - pill decorations for branches / remotes / tags / HEAD,
  - an "Uncommitted changes" row from `git status` (count + changed files vs
    HEAD),
  - click a commit to expand its full message and changed-file list with
    A/M/D/R status badges,
  - click a file to open its diff patch (commit shows `git show`, working tree
    shows `git diff HEAD`) in a dialog.
- The host keeps a real 56px right-edge icon rail when collapsed. Other
  right-panel pages can appear alongside Files and overflow into the host's
  searchable More menu.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: registers exact `/ _dsh/file-explorer/*` routes backed by the Host `fs`/`subprocess` services, plus read-only git routes (`/ _dsh/file-explorer/git-log`, `git-commit`, `git-diff`, `git-status`) that run `git` with machine-readable separators and return JSON only. |
| `client.js` | Client half: registers independent keyed `right-panel.page` entries for Files and Git Graph. |
| `cordis.patch.yml` | Composition patch that mounts the host row — declared with `inject: [webServer]`, so it activates only after the stock webserver service (`127.0.0.1`) is up. |

## Install

The package version is `@yiln-dsh/dsh-plugin-file-explorer@0.5.0`.

The right-panel package must be installed in the same `web` profile:

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-right-panel
dsh plugin --profile web add file:/path/to/dsh-plugin-file-explorer
```

### Tarball

```bash
cd /path/to/dsh-plugin-file-explorer
pnpm pack
```

```bash
dsh plugin --profile web add ./yiln-dsh-dsh-plugin-file-explorer-0.5.0.tgz
```

### npm package

```bash
cd /path/to/dsh-plugin-file-explorer
npm publish --access public
```

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-file-explorer@latest
```

The profile must be the `web` profile. The host row serves the API routes and
the client bundle loads with the web shell; restart `dsh web` after install to
apply the new profile composition.

## Behavior notes

- The Host falls back to `sandboxPolicy.workspaceRoot` when no path is passed,
  and returns `{ ok, path, parent, entries }` JSON — never live objects.
- `read` previews up to 1 MiB of UTF-8 text or 16 MiB of recognized images;
  image previews return a data URL for inline rendering. `download` returns a
  base64 data URL (64 MiB cap) that the browser triggers with `<a download>`.
- `delete` removes regular files (`rm -f`) and directories recursively
  (`rm -rf`); both are called only after a second-click confirm in the UI.
- Git routes are read-only. They resolve the repository root with
  `git rev-parse --show-toplevel` from the requested directory (or the
  workspace root), then run `git log --all --date-order` (default 300 commits,
  `req.all === false` for the current branch only), `git diff-tree -m
  --first-parent` for commit file lists, `git show` / `git diff HEAD` for
  patches, and `git status --porcelain=v1 -b` for the working tree. Commit
  hashes are validated against `^[0-9a-fA-F]{6,40}$` (or the `WORKING`
  sentinel) and file paths against a non-option, non-control-character check.
- Rows have a fixed 34px height, so the hover action swap never changes the
  row height; directories reveal a delete-only action set on hover.
- The browser module registers `file-explorer.files` and
  `file-explorer.git` into the keyed `right-panel.page` Slot and uses the
  standard session `useSessions` hook.
