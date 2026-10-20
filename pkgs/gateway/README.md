# gateway

One entry, many profiles. Standalone package
[`@yiln-dsh/dsh-gateway`](../../docs/changes/federation-design.md). Loader row: `gateway`.

```bash
dsh plugin --profile web add "github:<owner>/dsh-plugin#path:/pkgs/gateway"
```

See the [root README](../../README.md) for the workspace layout, migration and testing,
and [the design note](../../docs/changes/daemon-design.md) for the routing and
helper-deployment decisions.

## Upgrading from 0.3

The login model is one pairing credential. `username`, `twoFactorEnabled`,
`totpSecret`, `passkeyOrigin` and `passkeyRpId` are gone from the config schema;
a profile that still sets them is not rejected, but the plugin warns at mount
that they no longer do anything. Passkeys registered under 0.3 stop working, and
every session minted under the old model is revoked once on the first start, so
each browser pairs again.

Set `config.password` (or `DSH_AUTH_PASS`) before the first 0.4 start: with no
credential file and no password there is nothing to pair against, and the plugin
refuses to mount rather than serve a login page nobody can pass. Once
`daemon/auth/pairing.json` exists the configured password is only a seed and can
be removed.

## What it owns

- **The only public listener** (`0.0.0.0:3080` by default). TLS is terminated by
  an external proxy; this plugin never speaks TLS.
- **Authentication**: one pairing credential, one session cookie. That credential is
  the only way in: the login page asks for nothing else.
  The credential is stored as a scrypt hash in `daemon/auth/pairing.json` (0600);
  `config.password` / `DSH_AUTH_PASS` only seed that file on the first start, and a
  corrupt or absent file with no password stops the plugin from mounting.
  Sessions are minted under an authentication epoch: changing the credential model
  (bumping `SESSION_AUTH_EPOCH`) revokes every session the previous model issued —
  once, at the next start — so a browser has to pair again rather than keep a
  credential that no longer exists alive through its cookie.
- **Routing**: `/<id>/…` proxies to that profile's loopback port, HTTP and
  WebSocket alike.
- **Profile lifecycle**: create, start, stop, remove, plus `/admin` for operators.
- **SSH deployment**: probe a host, then install a statically linked helper.

## Why a profile cannot share a process

`fs`, `subprocess` and `sandbox` are process-wide services. One `ctx.fs` means one
execution world, so two targets need two processes. A remote profile keeps its
process here and moves only those three providers to the SSH host.
