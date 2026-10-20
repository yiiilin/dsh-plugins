# gateway

One entry, many profiles. Standalone package
[`@yiln-dsh/dsh-gateway`](../../docs/changes/federation-design.md). Loader row: `gateway`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/gateway"
```

See the [root README](../../README.md) for the workspace layout, migration and testing,
and [the design note](../../docs/changes/daemon-design.md) for the routing and
helper-deployment decisions.

## What it owns

- **The only public listener** (`0.0.0.0:3080` by default). TLS is terminated by
  an external proxy; this plugin never speaks TLS.
- **Authentication**: one pairing credential, one session cookie, optional TOTP.
  The credential is stored as a scrypt hash in `daemon/auth/pairing.json` (0600);
  `config.password` / `DSH_AUTH_PASS` only seed that file on the first start, and a
  corrupt or absent file with no password stops the plugin from mounting.
- **Routing**: `/<id>/…` proxies to that profile's loopback port, HTTP and
  WebSocket alike.
- **Profile lifecycle**: create, start, stop, remove, plus `/admin` for operators.
- **SSH deployment**: probe a host, then install a statically linked helper.

## Why a profile cannot share a process

`fs`, `subprocess` and `sandbox` are process-wide services. One `ctx.fs` means one
execution world, so two targets need two processes. A remote profile keeps its
process here and moves only those three providers to the SSH host.
