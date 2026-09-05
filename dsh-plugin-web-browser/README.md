# @yiln-dsh/dsh-plugin-web-browser

A DSH Web bundle plugin that adds a **server-side browser view** next to the
terminal in the conversation view tabs.

The browser runs **on the DSH host**, not in the operator's browser. This is
the key design point: when the DSH machine and the access end are on separate
networks, the operator's browser cannot reach the intranet content that DSH
can see. This plugin opens pages inside the DSH host's network, captures
frames via CDP `Page.startScreencast`, streams JPEG frames over a WebSocket to
the GUI, and injects mouse / wheel / keyboard events back into the real page.

- Registers a **浏览器 (Browser)** view in the `conversation.view` tab row, next to 对话 / 轨迹 / 终端, so it sits right beside the terminal.
- Opening the Browser view automatically creates one `about:blank` tab and shows a clean blank new-tab canvas; navigation is done from the top address bar. Closing the last tab returns to the empty state.
- Address bar with back / forward / reload, and a tab strip with up to 12 tabs.
- Each conversation session gets an isolated Chromium browsing context; browser
  API and WebSocket calls require a live session id and never use a shared
  default context.
- Frames are pushed as binary JPEG over `/_dsh/web-browser/ws`; the view renders them in an `<img>` and maps pointer / wheel / keyboard input back through the same WebSocket (CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent`).
- Security posture is intranet-first: `http`/`https` schemes (optional `file`), optional host allowlist, and **private-network access is allowed by default** because reaching intranet hosts is the point of this view. This intentionally differs from `dsh-plugin-browser-use`, which defaults to blocking private networks.
- `ws` is a runtime dependency for the Host WebSocket upgrade route; it is
  installed with this package rather than relying on another plugin's copy.

## Requirements

- Chromium-family browser reachable by the DSH host. Resolution order:
  1. `executablePath` config,
  2. `$DSH_BROWSER_EXECUTABLE`,
  3. well-known OS locations (`google-chrome-stable`, `chromium-browser`, `chromium`, Edge…),
  4. Playwright's own browser resolution (`npx playwright install chromium`).
- `playwright-core` is a runtime dependency and is only imported lazily when a browser is first opened.

## Layout

| File | Content |
| --- | --- |
| `index.js` | Host half: `/_dsh/web-browser/open|list|close` routes, the `/_dsh/web-browser/ws` upgrade route, per-session Chromium contexts, CDP screencast frame forwarding, and input injection. |
| `client.js` | Browser bundle: `conversation.view` browser tab (next to the terminal) with address bar, navigation, tab strip, `<img>` frame rendering and input capture. |
| `cordis.patch.yml` | Web-profile composition patch for the Host row. |

## Install

Local source directory:

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-web-browser
```

The view appears in the conversation tab row (对话 / 轨迹 / 终端 / 浏览器).
Restart `dsh web` after installing.

## Config

`dsh-plugin-web-browser` accepts a `config` object on its bundle row
(`cordis.patch.yml` or a profile overlay):

| Key | Default | Meaning |
| --- | --- | --- |
| `executablePath` | — | Explicit Chromium executable (else `$DSH_BROWSER_EXECUTABLE`, well-known locations, Playwright resolution). |
| `allowedHosts` | `[]` | Host allowlist, e.g. `["intranet.example.com", "*.corp.local"]`. Empty = any host. |
| `allowPrivateNetwork` | `true` | Permit loopback/private/link-local `http(s)` targets. This panel exists to reach intranet content, so it defaults to true. |
| `allowFile` | `false` | Permit `file://` URLs (local HTML preview, e.g. `data/study/*.html`). |

## Security notes

- Scheme allowlist: `http` / `https`, plus `file` only when `allowFile` is set.
- Host allowlist with `*.suffix` wildcard support; empty list allows all hosts.
- Private-network access defaults to **allowed** (unlike `dsh-plugin-browser-use`). Tighten with `allowPrivateNetwork: false` or an `allowedHosts` list if desired.
- The WebSocket carries no extra auth of its own; it rides the same `webServer` upgrade path as the rest of the GUI (and the `auth-webserver` gateway when deployed).
- Chromium launches with a private `HOME`/`XDG_*` directory that is removed on close, so profile, crashpad, and caches never touch the operator's home.
- A `file:` URL is read by the server-side Chromium; the operator never directly fetches intranet content in their own browser.

## Known limitations

- CDP `Page.startScreencast` only emits frames when the page changes (static pages emit one frame; animated content reaches ~60fps). This keeps bandwidth low but means a perfectly static page will not visibly update the cursor.
- IME (Chinese input) is not fully supported yet — plain ASCII keys and mouse interaction work; complex composition is a follow-up.
- The panel shows what the server-side Chromium renders; sites that detect headless automation may behave differently.

## Compatibility with deeptutor / browser-use

- `dsh-deeptutor` renders answers to self-contained HTML files (`html` parameter, `html-doc` skill). With `allowFile: true`, those files can be opened directly in this panel.
- `dsh-plugin-browser-use` drives its own headless Chromium for agent tool calls. Sharing a single browser session between the agent's tools and this visible panel is planned (both speak CDP); in this release they are independent.

The published package is `@yiln-dsh/dsh-plugin-web-browser@0.1.1`.
