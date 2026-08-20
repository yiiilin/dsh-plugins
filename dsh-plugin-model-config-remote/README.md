# dsh-plugin-model-config-remote

A Host-only DSH plugin that serves a self-contained model configuration page
backed directly by the Host `settings` service.

Unlike the built-in Models page, this page does not depend on the
loopback-pinned browser settings RPCs, so it works from any address that can
reach the DSH web server.

## Routes

- `GET /_dsh/model-config` — the editor page
- `GET /_dsh/model-config.js` — the page script
- `GET /_dsh/model-config-api` — current model settings snapshot
- `POST /_dsh/model-config-api` — save/reset one namespace

## Install

```bash
dsh plugin --profile web add /path/to/dsh-plugin-model-config-remote
```

## Configure

The page edits model-related namespaces: `agent-default-model`, `llm-deepseek`,
`llm-pi-ai`, and any other namespace starting with `llm-`.

> Security: this page intentionally bypasses the loopback config guard. Only
> expose DSH to networks you trust, or add authentication in front of it.
