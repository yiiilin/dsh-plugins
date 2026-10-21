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

**Do not set a password in the profile or the environment.** A 0.3 or 0.4
deployment seeded `daemon/auth/pairing.json` from one, which meant keeping a
plaintext copy around to generate a hash once; 0.5 has no such path, and the
key does nothing. If no credential file exists, the login page offers first-time
setup instead of the plugin refusing to mount — see the 0.5 section below for
what that trade-off costs.

## Upgrading from 0.4 to 0.5

`config.password`, `DSH_AUTH_PASS` and `AUTH_PASS` no longer do anything. They were
a *seed*: a value hashed into `daemon/auth/pairing.json` on the first start and not
consulted again. Keeping them meant a plaintext copy of the credential existed for
the sole purpose of generating a hash once, so the whole path is gone. The
credential now has exactly one source: the scrypt hash in that file.

A profile that still sets the key, or an environment that still sets either
variable, is not rejected — schemastery merges unknown keys rather than rejecting
them — but the plugin warns at mount that they have no effect. The check compares
the value to the empty string and nothing else: never seeded, never logged, never
authenticated against. Removing the key is what actually deletes the plaintext;
the daemon cannot delete a line from a profile it does not own. Silence would let an
operator believe the configured password still decides who can log in.

Nothing to do for an existing deployment: a `pairing.json` written by 0.4 keeps
working unchanged, because the file was always what verification consulted. Do
remove the plaintext from the profile and the launch environment — that is the
point of the change.

Two behaviours are new in 0.5.

**A missing credential file no longer stops the mount.** The login page offers
first-time setup instead. That makes an install finishable from another machine
on the network; it also means that after the file is deleted, anyone who can
reach the daemon can set it. See the section below before relying on it.

**The credential can be changed from the panel**, without a shell and without a
restart. The change takes effect immediately and signs out every other session;
the one making the change stays signed in, having just proved it knows both the
old and the new value. The panel's third tab lists the sessions on this node and
every edge, so "who is signed in" has one answer instead of one per machine.

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

## Changing the credential

`POST /admin/credential` replaces the pairing credential for an already signed-in
caller. The body is `{ current, password, confirm }` — the credential in force, the
new one, and the new one again — and the answer is either `{ ok: true }` or
`{ ok: false, error }`.

**The current credential is required, and a session is not enough.** Sessions live
for a long time by default, so a change authorised by a session alone would turn
one login into a permanent takeover: anyone at an unlocked browser could replace
the login credential and lock the operator out. A wrong or missing `current` is
refused with 403 — not 401, because the session is genuine; what is missing is the
proof, and a 401 would invite the browser to "log in again", the one thing a
failed change must not do.

The new value is judged by the same rule as first-time setup — non-empty, at least
`PAIRING_CREDENTIAL_MIN_LENGTH` (12) characters, and the two entries equal — and
`confirm` is checked by the endpoint as well as by the form, because a request
that skips the page is not a reason to accept one entry as if it had been typed
twice. Every refusal happens before anything is written, so a rejected change
leaves the file byte-for-byte as it was.

On success the file is rewritten (atomically, 0600), the in-memory hash is swapped,
and **every session except the caller's own is revoked** — in the store, before the
answer is written, so the change is in force on the next request rather than at the
next restart. The caller has just proved it holds both the old and the new
credential, so signing it out would cost a login and buy nothing; every other
session is exactly what a leaked credential would have left behind. The revocation
is persisted, so a restart does not read the withdrawn records back.

Nothing about the credential is returned: no last-changed time, no mask, no
fragment, and no statement about whether the new value differs from the old. The
response body is exactly `{ ok: true }`, which is also why there is no `GET` on the
route — it would have nothing to answer with that the ticket permits showing.

The route is answered on both roles: an edge has its own login, and an operator who
suspects that machine's credential leaked should be able to fix it there rather
than from the main node. It sits behind the same session gate as the rest of
`/admin`, and a request that arrives over a tunnel carries no session, so a peer
node cannot change this daemon's credential.

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
  expiry times, and which one is asking. That view is read-only. The one write the
  layer owns is `changeCredential(...)`, which writes the file, swaps the hash and
  revokes every other session; both stores are its own, so a caller cannot half-apply
  a change or reach either store to do it another way.
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
