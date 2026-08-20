# dsh-plugin-original-models-page-patch

A Host-only DSH plugin that makes the **original** built-in Models settings
page writable when the browser is **not** on `127.0.0.1`, without restarting
DSH.

## How it works

1. Patches the official `dsh-client-ui-settings` bundle so the settings mirror
   keeps using Host persistence for non-loopback browsers, then bumps the
   bundle revision via `clientModules.rebuilt` so the page loads the patched
   version on refresh.
2. Registers exact `/api/settings.*` and `/api/credentials.*` routes that
   serve through the Host `settings`/`credentials` services, bypassing the
   loopback-pinned browser RPC guard.

## Install

```bash
dsh plugin --profile web add /path/to/dsh-plugin-original-models-page-patch
```

Then refresh the DSH web page once.

## Notes

- The client bundle patch modifies DSH's installed package file in place and
  is idempotent.
- This intentionally bypasses the loopback config guard. Only expose DSH to
  networks you trust, or add authentication in front of it.
- The equivalent route-override for the **independent page** lives in
  `dsh-plugin-model-config-remote`.
