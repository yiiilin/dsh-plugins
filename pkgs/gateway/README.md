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

## Upgrading from 0.4

`config.password`, `DSH_AUTH_PASS` and `AUTH_PASS` no longer do anything. They were
a *seed*: a value hashed into `daemon/auth/pairing.json` on the first start and not
consulted again. Keeping them meant a plaintext copy of the credential existed for
the sole purpose of generating a hash once, so the whole path is gone. The
credential now has exactly one source: the scrypt hash in that file.

A profile that still sets the key, or an environment that still sets either
variable, is not rejected — schemastery merges unknown keys rather than rejecting
them — but the plugin warns at mount that they have no effect. Silence would let an
operator believe the configured password still decides who can log in.

Nothing to do for an existing deployment: a `pairing.json` written by 0.4 keeps
working unchanged, because the file was always what verification consulted. Do
remove the plaintext from the profile and the launch environment — that is the
point of the change.

## What it owns

- **The only public listener** (`0.0.0.0:3080` by default). TLS is terminated by
  an external proxy; this plugin never speaks TLS.
- **Authentication**: one pairing credential, one session cookie. That credential is
  the only way in: the login page asks for nothing else.
  The credential is stored as a scrypt hash in `daemon/auth/pairing.json` (0600) and
  comes from that file alone — there is no configured seed and no environment
  fallback, so no plaintext copy exists anywhere. A corrupt or absent file stops the
  plugin from mounting.
  Sessions are minted under an authentication epoch: changing the credential model
  (bumping `SESSION_AUTH_EPOCH`) revokes every session the previous model issued —
  once, at the next start — so a browser has to pair again rather than keep a
  credential that no longer exists alive through its cookie.
  The layer also reports the live sessions (`sessions(currentId)`), which is what the
  panel's session table reads: id, client address, client type, issue, last-seen and
  expiry times, and which one is asking. The view is read-only.
- **Routing**: `/<id>/…` proxies to that profile's loopback port, HTTP and
  WebSocket alike.
- **Profile lifecycle**: create, start, stop, remove, plus `/admin` for operators.
- **SSH deployment**: probe a host, then install a statically linked helper.

## Why a profile cannot share a process

`fs`, `subprocess` and `sandbox` are process-wide services. One `ctx.fs` means one
execution world, so two targets need two processes. A remote profile keeps its
process here and moves only those three providers to the SSH host.
