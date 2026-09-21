# DSH Compatibility

This repository targets the DSH Web bundle, not only the `@deepseek-ai/dsh` CLI
package. Compatibility must therefore be checked against the DSH packages that a
plugin injects and the Cordis services/Slots that its Host and Client halves use.

## Verified package lines

| DSH line | npm channel | Status |
| --- | --- | --- |
| `0.1.5-rc.2` | `latest` | Installed locally and used as the current baseline. |
| `0.1.6-alpha.2` | `alpha` | Static Host/Client bundle checks run locally; the explicit adaptations in this file are covered. Full daemon recovery and deployment smoke are still required before treating it as a release baseline. |

`npm latest` currently resolves to `0.1.5-rc.2`. The newer `0.1.6-alpha.2`
package is the `alpha` dist-tag, so it must be tested explicitly rather than
assuming that `@latest` exercises it.

## Compatibility seams

The following changes are intentionally handled in the plugin code:

- Right Sidebar guide entries now carry a required per-provider `id` in
  `0.1.6-alpha.2`. Git Graph, Terminal, and Browser provide one while remaining
  accepted by rc.2.
- Settings Plugins renamed the external configuration-card slot from
  `settings.plugin.item` to `plugins.item`. Auth Webserver and Web Daemon register
  into both names; the live DSH Slot declaration decides which one is mounted.
- The Models settings bundle moved advanced model rows into `ModelRow` in
  `0.1.6-alpha.2`. `dsh-plugin-llm-adapter` has separate shape-checked patch paths
  for rc.2 and alpha.2. If neither shape matches, it leaves the upstream bundle
  untouched and logs an actionable error.
- `dsh-llm` alpha removed `offloadRequestImagesWithPolicy`. The adapter keeps the
  rc.2 function when it exists and uses an equivalent local image-prefix fallback
  on alpha, including nested tool-result images and deterministic placeholders.
  This preserves this fork's request path; it does not claim to reproduce alpha's
  durable `offloaded` marks and `IMAGE_OFFLOAD_REQUIRED` retry protocol.
- The Browser Host WebSocket upgrade path now declares its URL variable. This is
  a current correctness fix that also makes the compatibility smoke deterministic.
- Git Graph, Browser, and Voice Input declare the client/Host capabilities they
  actually consume in their manifests and bundle patches.

## Still version-locked or unverified

These areas use DSH internal behavior with no stable cross-release contract and
must remain in the release test matrix:

- `web-daemon` recovery maps `sessionController`, `subagents`, persistence
  snapshots, and refusal codes. An API rename can silently weaken recovery even
  when the plugin still loads.
- `auth-webserver` and `llm-adapter` rewrite installed client bundles through
  `clientModules.clientPath()`/`rebuilt()` and source anchors. The code fails
  closed when an anchor is absent, but those features need a bundle-shape smoke
  on every DSH release.
- Delete Session still targets the stock JSONL persistence backend and its
  `locate()` path shape. In alpha, `ClientSessions` also moved navigation away
  from `sessions.open()`/`clear()`; the plugin refreshes the catalog and reloads
  as a compatibility fallback when those legacy navigation methods are absent.
- File Message intentionally targets the stock JSONL persistence backend and its
  `locate()` path shape. It must report unsupported backends instead of pretending
  to be portable.
- Terminal, Git Graph, and Browser depend on the subprocess/PTY, filesystem,
  right-sidebar, and WebSocket service contracts. A missing capability must keep
  the feature disabled or return a clear error; it is not evidence of DSH support.

## Release checks

For each supported DSH line, run:

1. `node --check` on every changed JavaScript file.
2. The package unit tests in every changed plugin directory.
3. A Web profile startup with the plugin bundle patch applied.
4. Client loading and Slot registration checks for right-sidebar, settings-card,
   conversation, and tool-view contributions.
5. Host route and WebSocket checks for Browser, Terminal, Voice Input, and the
   file/graph HTTP APIs.
6. An LLM adapter check covering row replacement, model discovery, credentials,
   replay, and the total stream timeout.
7. A Web Daemon restart check covering both top-level sessions and running
   subagent children.

The package peer ranges explicitly admit the tested rc window and `0.1.6-alpha.2`
while rejecting unverified alpha.3/0.1.6 releases. They are an installation guard,
not a compatibility proof: a DSH version should be called supported only after
these checks pass for that exact package line.
