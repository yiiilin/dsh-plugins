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

## First-time setup, and the trade-off it accepts

When `daemon/auth/pairing.json` does not exist the daemon still starts, and the
login page becomes a **setup form** instead of a login form: enter a new pairing
credential twice, submit, and that browser is signed in with it directly. The
credential is hashed and written, and the page goes back to asking for it once —
the ordinary login form — from then on. There is one condition for this shape and
no other: the file's absence. A brand-new machine and one whose credential file
was deleted are the same state on purpose, because for the person in front of the
browser they are the same situation.

Validation is the same rule in both places that ask for a new credential (setup
and the later change flow): non-empty, at least 12 characters
(`PAIRING_CREDENTIAL_MIN_LENGTH`), and the two entries must match. A refused
attempt writes nothing, so a failed setup leaves the machine exactly as it was.

**The trade-off: the setup form is not restricted by source address.** While the
file is missing, anyone who can reach the daemon — from any address it is
reachable at — can set the credential. That is deliberate, and it buys the thing
this feature exists for: an install can be finished from another machine on the
LAN, without first editing a profile or logging in over SSH. The cost is its
mirror image: deleting the file (which is also how the credential is reset) opens
a window in which anyone who can reach the daemon can take the credential over,
until somebody sets one. This is the opposite of the usual default, which narrows
rather than widens access, so it is written down here and in
`lib/auth/pairing-credential.js` — not only in the design notes. Treat the
daemon's listening address as the thing that decides who is inside that window.

A *corrupt* `pairing.json` is still a startup failure: the plugin refuses to mount
rather than serve a page that accepts nothing. Only absence is a state the page
can lead out of.

## What it owns

- **The only public listener** (`0.0.0.0:3080` by default). TLS is terminated by
  an external proxy; this plugin never speaks TLS.
- **Authentication**: one pairing credential, one session cookie. That credential is
  the only way in: the login page asks for nothing else.
  The credential is stored as a scrypt hash in `daemon/auth/pairing.json` (0600) and
  comes from that file alone — there is no configured seed and no environment
  fallback, so no plaintext copy exists anywhere. A corrupt file stops the plugin
  from mounting; a missing one turns the login page into the first-time setup form
  described above (and is why the page is reachable, by anyone, while it is missing).
  Sessions are minted under an authentication epoch: changing the credential model
  (bumping `SESSION_AUTH_EPOCH`) revokes every session the previous model issued —
  once, at the next start — so a browser has to pair again rather than keep a
  credential that no longer exists alive through its cookie.
  The layer also reports the live sessions (`sessions(currentId)`), which is what the
  panel's session table reads: id, client address, client type, issue, last-seen and
  expiry times, and which one is asking. The view is read-only.
- **The session overview**: `GET /admin/sessions` answers every node's live sessions as
  one per-node envelope, `{ ok, partial, nodes: [{ id, role, state, label?, sessions?,
  error? }] }`. This node is `id: "self"`; every registered environment gets its own
  entry, obtained by relaying the same route to it over its tunnel. All environments are
  asked at once, so the table costs one relay timeout in the worst case rather than one
  per unreachable machine. `state` is `ok`, `offline`, `timeout` or `error`, and
  `sessions` is present only for `ok` — a node that could not be read has no list to be
  mistaken for a node nobody is signed in on. `partial` is true when any node did not
  answer; the answer itself is still 200. The route is read-only: any method but `GET`
  is refused with 405, and no route anywhere revokes a session.
- **Routing**: `/<id>/…` proxies to that profile's loopback port, HTTP and
  WebSocket alike.
- **Profile lifecycle**: create, start, stop, remove, plus `/admin` for operators.
- **SSH deployment**: probe a host, then install a statically linked helper.

## Why a profile cannot share a process

`fs`, `subprocess` and `sandbox` are process-wide services. One `ctx.fs` means one
execution world, so two targets need two processes. A remote profile keeps its
process here and moves only those three providers to the SSH host.
