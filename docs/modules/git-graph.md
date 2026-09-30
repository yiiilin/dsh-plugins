# git-graph

Internal module of `@yiln-dsh/dsh-plugins`. Install and release the root package;
this module has no separate npm package or version. Loader row: `dsh-git-graph`.
See the [root README](../../README.md) for installation, migration and testing.

A DSH `dsh.bundle` that contributes the **Git Graph** page tab to the DSH Web
right Sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`, shipped with DSH
0.1.5+). The product ships its own Files page, so this plugin deliberately
registers only the Git page kind.

- Registers the page kind in `ctx.sidebarRightTabs` and its body in the
  `sidebar.right.pane.tab` seat, keyed by the type id, with a guide capsule so
  it can be opened from an empty pane.
- **Self-contained assets**: the diff dialog's editor and the markdown preview
  load from this plugin's own routes — the monaco tree at
  `/_dsh/git-graph/monaco/vs` and markdown-it at
  `/_dsh/git-graph/vendor/markdown-it.mjs` — served verbatim from the
  `monaco-editor` and `markdown-it` dependencies, with no CDN and no bundler
  step. Installing this plugin installs everything its pages need; it never
  requires `@yiln-dsh/dsh-plugin-file-explorer` to be present.
- **Git Graph**: a vscode/le-git-graph style commit graph rendered from the
  repository containing the current directory —
  - colored lane graph with commit dots and merge curves (all branches or the
    current branch, refreshable),
  - pill decorations for branches / remotes / tags / HEAD,
  - an "Uncommitted changes" row from `git status` (count + changed files vs
    HEAD), listing each file inside an untracked directory individually,
  - click a commit to expand its full message and changed-file list with
    A/M/D/R status badges,
  - click a file to open its diff patch (commit shows `git show`, working tree
    shows `git diff HEAD`) in a dialog.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: read-only git routes under `/_dsh/git-graph` (`git-log`, `git-commit`, `git-diff`, `git-status`) that run `git` with machine-readable separators and return JSON only, plus the bundled-asset routes for the monaco tree and markdown-it. |
| `client.js` | Client half: registers the Git page kind in `ctx.sidebarRightTabs` and its body in the `sidebar.right.pane.tab` seat. |
| `cordis.patch.yml` | Composition patch that mounts the host row — declared with `inject: [webServer, subprocess, fs, sandboxPolicy]`, so it activates only after the stock webserver service is up and receives the capabilities used by the Git routes. |
