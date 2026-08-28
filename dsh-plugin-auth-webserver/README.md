# @yiln-dsh/dsh-plugin-auth-webserver

A DSH `dsh.bundle` that keeps the stock webserver untouched and adds an
**auth-gated reverse proxy** for LAN or explicitly configured public access:

- the stock `dsh web` server stays on `127.0.0.1:3080` (loopback, no auth);
- this bundle listens on every **non-loopback NIC address** at the same port
  (e.g. `192.168.1.5:3080`);
- it requires HTTP Basic Auth or an HMAC login cookie; TOTP can be required to disable Basic Auth;
- configured Host/Origin policy, HTTPS enforcement, bounded authentication
  rate limits, short absolute/idle sessions, and security response headers are
  available for internet-facing deployments;
- every accepted request — including WebSocket upgrades — is proxied to the
  stock `127.0.0.1:3080` server.

So the default web module is a *new* module instead of a replacement: local
access behaves exactly like stock DSH, and LAN clients get the full GUI behind
authentication.

## Install

The published package is `@yiln-dsh/dsh-plugin-auth-webserver@0.4.0`.

The plugin is plain JavaScript source; there is no build step.

### Local source directory

If you have this checkout (or unpacked source), install it directly:

```bash
dsh plugin --profile web add file:/path/to/dsh-plugin-auth-webserver
```

### Tarball

Pack the plugin, then install the `.tgz` on the target machine:

```bash
cd /path/to/dsh-plugin-auth-webserver
pnpm pack
```

```bash
dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.4.0.tgz
```

The tarball already contains the runnable source. A user can also unpack it,
edit the source, repack with `pnpm pack`, and install the new tarball.

### npm package

Publish the directory, then install by name:

```bash
cd /path/to/dsh-plugin-auth-webserver
npm publish --access public
```

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@latest
```

Pin a version if you want reproducible installs:

```bash
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@0.4.0
```

### Direct GitHub

Direct GitHub URL installs only work when the GitHub repository root is the
plugin package itself. This repo keeps each plugin in a subdirectory, so use
npm publish or a plugin tarball for distribution. If this plugin is later kept
in its own repository, pin the commit:

```bash
dsh plugin --profile web add github:<owner>/dsh-plugin-auth-webserver#<commit-sha>
```

The profile must already be the `web` profile, and the package must be started
with `dsh web` (or `dsh --profile web`). Do not pass `--host 0.0.0.0`: the
stock CLI rejects it, and the gateway discovers LAN NIC addresses itself.

## Versioning

The plugin version is defined by the `version` field in `package.json`:

```json
{
  "name": "@yiln-dsh/dsh-plugin-auth-webserver",
  "version": "0.4.0"
}
```

Semantic versioning is recommended:

- `0.3.0` -> `0.3.1` for a bug fix
- `0.3.0` -> `0.4.0` for a backward-compatible feature
- `0.3.0` -> `1.0.0` for a breaking change

The selected version is used for:

- npm registry resolution, e.g. `@yiln-dsh/dsh-plugin-auth-webserver@0.4.0`
- the generated tarball name, e.g. `yiln-dsh-dsh-plugin-auth-webserver-0.4.0.tgz`
- the metadata inside the tarball/npm package

A `file:` source install uses the version that is currently in the source tree;
no registry pinning applies. A direct GitHub install is pinned by the commit or
branch after `#`, not by `package.json` alone.

## Configure

Credentials are resolved in this order:

1. `DSH_AUTH_USER` / `DSH_AUTH_PASS`, or `AUTH_USER` / `AUTH_PASS`
2. the settings user document (`$DSH_HOME/settings.yaml`, namespace
   `auth-webserver`) — what the GUI card writes
3. the `webserver-auth` row config (the composed base layer)

The gateway refuses to authenticate anyone when no password is configured
(but the stock loopback server keeps working). A home-level `$DSH_HOME/.env`
works for `AUTH_*` (DSH reserves the `DSH_` prefix):

```bash
# $DSH_HOME/.env
AUTH_USER=admin
AUTH_PASS='<random password of at least 20 characters>'
# Require TOTP; this also disables Basic Auth.
AUTH_2FA_ENABLED=true
AUTH_2FA_REQUIRED=true
AUTH_2FA_SECRET='<32-character Base32 secret>'
# Public reverse-proxy policy. Comma-separated values are accepted.
AUTH_ALLOWED_HOSTS=dsh.yiln.de
AUTH_ALLOWED_ORIGINS=https://dsh.yiln.de
AUTH_REQUIRE_HTTPS=true
# IP address(es) of the TLS-terminating reverse proxy, not client-supplied.
AUTH_TRUSTED_PROXY_ADDRESSES=192.0.2.10
```

`AUTH_2FA_REQUIRED=true` is a deployment policy: it keeps TOTP enabled even if
settings or `AUTH_2FA_ENABLED=false` try to disable it. `AUTH_2FA_SECRET` is a
secret-role value. When 2FA is enabled, Basic Auth is rejected completely; use
the browser login form or POST the password and OTP to `/api/auth.login` and
keep the returned session cookie.

For a public hostname, `AUTH_ALLOWED_HOSTS` is required. Without an explicit
list, the gateway falls back to its bind addresses for backwards-compatible
LAN operation, which does not include a DNS name. `AUTH_ALLOWED_ORIGINS` is an optional additional allowlist; an attached Origin
must still match the request Host. It may be omitted when same-Host Origins are
sufficient. `AUTH_REQUIRE_HTTPS=true` requires either native TLS on the request
or an `X-Forwarded-Proto: https` header from an address listed in
`AUTH_TRUSTED_PROXY_ADDRESSES`; the header must be exactly `https` and an
unlisted client cannot assert HTTPS with a forged header.

Or start it explicitly:

```bash
DSH_AUTH_USER=admin DSH_AUTH_PASS='change-me' dsh web --no-open
```

The browser login form sets a 24-hour `HttpOnly` session cookie plus a CSRF
cookie by default. Over HTTPS it uses `__Host-` cookie names, `Secure`, and
`SameSite=Strict`; the legacy names remain only for plain-HTTP LAN
compatibility. The session also expires after 12 hours of inactivity by default.
automation clients can use a standard Basic Auth header against a LAN address,
but every failed Basic attempt is subject to the same bounded rate limiter as
form login.

```bash
curl -u admin:'change-me' http://192.168.1.5:3080/
```

With 2FA enabled, obtain a cookie with both credentials and the current TOTP
code instead of using Basic Auth:

```bash
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me","otp":"123456"}' \
  http://192.168.1.5:3080/api/auth.login
```

## Configure from the Web GUI

Settings > Plugins > Plugin configuration has an "Auth webserver" card that
edits the username, password, realm, and optional TOTP 2FA. Saving writes the
`auth-webserver` namespace of `$DSH_HOME/settings.yaml` (the password and TOTP
secret are secret-role fields: they never leave the Host unredacted). Public
Host/Origin policy, HTTPS enforcement, proxy trust addresses, rate limits, and
session lifetimes belong in the deployment row or environment, not in the
browser settings card.

To enable 2FA, choose **Set up 2FA**, add the one-time setup key or URI to a
TOTP authenticator, enter the current password and the new six-digit code, then
confirm. The implementation uses SHA-1, six digits, a 30-second period, and a
one-step server-clock tolerance. Rotating or disabling 2FA requires the current
password and current authenticator code. All existing sessions and WebSocket
connections are revoked after a credential or 2FA change, so the browser must
sign in again.

The `AUTH_*` env vars outrank settings, and the `webserver-auth` row config acts
as the base layer until you save an override. Leave the password field empty to
keep the current password. `AUTH_2FA_REQUIRED=true` is the recommended public
setting because it prevents a settings change from re-enabling Basic Auth. The
`DSH_AUTH_*` names are also accepted for all deployment policy variables.

Older releases stored credentials in
`$DSH_HOME/plugins/dsh-plugin-auth-webserver/state.json`; on first boot the
plugin migrates an existing file into the settings namespace once (the file is
kept as a backup and can be deleted afterwards).

## Override target or port

Edit `$DSH_HOME/profiles/web/cordis.patch.yml` after installing:

```yaml
- id: webserver-auth
  config:
    port: 3080          # gateway port on each non-loopback NIC
    targetHost: '127.0.0.1'
    targetPort: 3080    # the stock DSH web server port
    addresses: []       # optional explicit bind list; empty = auto-detect NICs
    username: 'admin'
    password: 'your-password'
    twoFactorEnabled: true
    requireTwoFactor: true
    allowedHosts: ['dsh.yiln.de']
    allowedOrigins: ['https://dsh.yiln.de']
    trustedProxyAddresses: ['192.0.2.10']
    requireHttps: true
    sessionMaxAgeSeconds: 86400
    sessionIdleTimeoutSeconds: 43200
    loginMaxAttempts: 10
    loginWindowSeconds: 60
    maxLoginAttemptEntries: 10000
    upstreamTimeoutMs: 30000
    requestTimeoutMs: 120000
    headersTimeoutMs: 15000
    keepAliveTimeoutMs: 5000
    # Never put the TOTP secret in this non-secret config layer.
```

`port`/`targetPort` default to the stock web port (`dsh web --port ...`).
The gateway binds each non-loopback IPv4 address separately — it never binds
`0.0.0.0`, because that would collide with the stock loopback listener.

## Notes

Plain `http://` LAN addresses are not secure contexts, so browsers there lack
`crypto.randomUUID`, which the DSH client RPC layer needs. This bundle
registers an index tap on the stock webserver that injects a
`crypto.randomUUID` polyfill into every served index page (loopback included),
keeping the GUI usable over plain HTTP on LAN addresses.

TOTP protects against password-only compromise; it does not encrypt the LAN
connection. Put the gateway behind HTTPS or a trusted VPN/tunnel before using
it across an untrusted network. For a TLS-terminating reverse proxy, configure
`trustedProxyAddresses` and `X-Forwarded-Proto: https`; the gateway then emits
`Secure` cookies only for that trusted proxy path. Direct clients cannot make a
forged forwarding header turn an HTTP request into a secure one. HTTPS responses
include HSTS, frame, MIME, referrer, and permissions hardening headers; private
responses are marked `no-store`.

The gateway validates the configured Host and browser Origin before any
authentication or proxying. It rejects malformed request targets, requires JSON
for the login endpoint, accepts logout only by POST with CSRF validation for
browser sessions, bounds failed-authentication memory, rate-limits both Basic
and form attempts, and tears down both sides of upgraded WebSockets on revoke or
disposal. A fresh process also starts with a new session generation, so old
cookies cannot be revived by a restart.

The login page links the stock `/manifest.webmanifest` and `/favicon.svg`, and
those two metadata paths are available before authentication so Chromium can
show the install action. The DSH application, APIs, assets, and WebSocket
connections remain authentication-gated; installing the app does not bypass
login.