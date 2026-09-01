# @yiln-dsh/dsh-plugin-file-message

A DSH `dsh.bundle` that lets the model send workspace-backed files and images into the conversation.

The plugin deliberately uses **live file references**, not copied attachment objects:

- `send_image` accepts an existing PNG, JPEG, WebP, or GIF in the current session workspace.
- `send_file` accepts any regular file in the current session workspace.
- The source path is stored in the tool result presentation metadata and in the session sidecar `send-attachments-metas.json` next to `session.jsonl.zstd`.
- The browser card reads the current file through the Host when it needs an image preview or download.
- Deleting or moving the source file makes the historical message unavailable; deleting a session does not delete workspace files.

## UI

Images render as a constrained preview with a **View original** lightbox and **Download original** action. Files render as a filename, media type, size, and **Download** action. Markdown files (`.md`, `.markdown`, `.mdx`) additionally render an inline rendered preview below the file row, with the download action preserved. The card is replayable because its path metadata is persisted with the `tool/result` event.

The image preview uses the current file bytes and CSS constraints rather than creating a second thumbnail object. Preview reads are capped at 16 MiB; markdown text previews are capped at 1 MiB.

The markdown renderer is markdown-it's standalone ESM build (the `./browser`
export) served verbatim by the Host under
`/_dsh/file-message/vendor/markdown-it.mjs` — no CDN, no bundler step. The
browser loads it with dynamic `import()`. The ESM build is deliberate: the
UMD build's AMD branch would be taken whenever a global `define` exists (the
monaco loader in the same page), registering the module anonymously instead
of exposing the constructor. Rendering happens in the browser with
`html: false` (raw HTML inside the file is escaped) and markdown-it's
built-in `validateLink` rejects `javascript:`/`vbscript:`/`file:`/`data:`
hrefs, so workspace files never inject markup or scripts into the page.

Downloads are **native streaming**: the Download action is a plain link to the Host content route, which pipes the resolved workspace file straight into the HTTP response (`Content-Disposition: attachment`). The browser downloads natively — no fetch + blob buffering in page memory, no base64, and **no 64 MiB transfer ceiling** for downloads. Sending a file into the conversation still requires the file to fit in a 64 MiB read (the model-facing `send_file` bound), but downloading a sent file is unbounded.

## Persistence

For the stock JSONL session backend, one successful send appends an item to:

```text
<session-directory>/send-attachments-metas.json
```

The file has this shape:

```json
{
  "version": 1,
  "sessionId": "session-...",
  "items": {
    "call-id": {
      "callId": "call-id",
      "toolName": "send_image",
      "kind": "image",
      "path": "/workspace/output/result.png",
      "cwd": "/workspace",
      "displayName": "result.png",
      "mediaType": "image/png",
      "size": 183420,
      "version": "...",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Writes are serialized per session and published through a temporary file plus rename. The Host resolves the session's persistence location instead of reconstructing the encoded session-directory name.

## Security and limits

- Paths are resolved through DSH's `fs` service against the current session cwd.
- The resolved target must remain inside the session workspace.
- Symlink escapes are rejected by canonical containment.
- Only regular files are accepted.
- The Host re-resolves and re-stats the recorded path for every preview or download, and streams it through `ctx.fs.processPath` after the workspace-containment check.
- The `content` route serves three modes: `preview` (images, ≤ 16 MiB), `text` (text/* files, ≤ 1 MiB, used by the markdown card), and `download` (native streaming, unbounded).
- The browser never receives a `file://` URL or reads a local path directly.

## Install

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-file-message
```

Restart `dsh web` after installing the profile Bundle. The plugin is plain JavaScript and has no build step.
