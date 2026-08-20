# dsh-plugins

A repository of plugins for DeepSeek Harness (DSH). Each plugin lives in its
own directory.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [`dsh-plugin-auth-webserver`](./dsh-plugin-auth-webserver) | Replace the stock webserver with an auth-gated webserver bound to `0.0.0.0`. |
| [`dsh-plugin-model-config-remote`](./dsh-plugin-model-config-remote) | Self-contained remote model configuration page backed by the Host settings service. |
| [`dsh-plugin-original-models-page-patch`](./dsh-plugin-original-models-page-patch) | Makes the original Models settings page writable from non-loopback addresses. |

## Install

Each package is installed per-profile, for example:

```bash
dsh plugin --profile web add /path/to/dsh-plugin-auth-webserver
dsh plugin --profile web add /path/to/dsh-plugin-model-config-remote
dsh plugin --profile web add /path/to/dsh-plugin-original-models-page-patch
```
