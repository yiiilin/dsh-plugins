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
  stock `127.0.0.1:3080` server;
- narrow browser viewports receive a full-width mobile conversation shell with
  drawer navigation and a mobile details panel, while desktop viewports keep
  the stock three-column layout;
- the gateway maintains owner-only persistent browser-session records, so valid
  Cookie sessions survive a daemon restart and can be revoked individually from
  the settings card;
- the gateway supplies a complete PWA manifest, 180/192/512px PNG icons,
  iOS home-screen metadata, and a pass-through service worker;
- optional WebAuthn Passkeys can replace password entry for enrolled devices,
  while password/TOTP recovery remains available;
- an auth-owned in-app configuration editor replaces the server-native **Open
  configuration file** action for remote Settings pages; it does not depend on
  File Explorer, and a deliberately unsafe HTTP opt-in exists only for trusted
  LAN deployments.

So the default web module is a *new* module instead of a replacement: local
access behaves exactly like stock DSH, and LAN clients get the full GUI behind
authentication.

## Install

The published package is `@yiln-dsh/dsh-plugin-auth-webserver@0.7.0`.

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
dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.7.0.tgz
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
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@0.7.0
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
  "version": "0.7.0"
}
```

Semantic versioning is recommended:

- `0.3.0` -> `0.3.1` for a bug fix
- `0.3.0` -> `0.4.0` for a backward-compatible feature
- `0.3.0` -> `1.0.0` for a breaking change

The selected version is used for:

- npm registry resolution, e.g. `@yiln-dsh/dsh-plugin-auth-webserver@0.7.0`
- the generated tarball name, e.g. `yiln-dsh-dsh-plugin-auth-webserver-0.7.0.tgz`
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
# Optional WebAuthn relying-party settings; keep the RP ID stable.
AUTH_PASSKEY_RP_ID=dsh.yiln.de
AUTH_PASSKEY_RP_NAME='DeepSeek Harness'
```

`AUTH_2FA_REQUIRED=true` is a deployment policy: it keeps TOTP enabled even if
settings or `AUTH_2FA_ENABLED=false` try to disable it. `AUTH_2FA_SECRET` is a
secret-role value. When 2FA is enabled, Basic Auth is rejected completely; use
the browser login form or POST the password and OTP to `/api/auth.login` and
keep the returned session cookie.

The login page supports Simplified Chinese and English. It uses an explicit
`?lang=zh` or `?lang=en` query when present, otherwise it follows the browser's
`Accept-Language`; the selected language is preserved through the login POST.
The username, password, and TOTP controls use standard password-manager form
semantics, including `autocomplete="one-time-code"` and a `name="totp"` field.
Bitwarden's browser extension and iOS credential provider can use that field.
The current Bitwarden Android Autofill Service only returns username/password
for login credentials, so a website cannot make its Android app autofill a
stored TOTP; use Bitwarden's copy-code action or the system/browser integration
that supports TOTP.

When at least one Passkey is enrolled, the login page shows a Passkey action.
Passkey ceremonies require HTTPS; the WebAuthn exception is limited to the
`localhost` hostname. Use a stable HTTPS hostname and keep `AUTH_PASSKEY_RP_ID`
unchanged after registration. The RP ID has no scheme or port, for example
`dsh.yiln.de`; the browser Origin is the exact public HTTPS origin.

For a public hostname, `AUTH_ALLOWED_HOSTS` is required. Without an explicit
list, the gateway falls back to its bind addresses for backwards-compatible
LAN operation, which does not include a DNS name. `AUTH_ALLOWED_ORIGINS` is an optional additional allowlist; an attached Origin
must still match the request Host. It may be omitted when same-Host Origins are
sufficient. `AUTH_REQUIRE_HTTPS=true` requires either native TLS on the request
or an `X-Forwarded-Proto: https` header from an address listed in
`AUTH_TRUSTED_PROXY_ADDRESSES`; the header must be exactly `https` and an
unlisted client cannot assert HTTPS with a forged header.

The gateway injects a mobile presentation shell into the official index page by
default. At viewports up to 760px it removes the desktop 56px rail, expands the
conversation to the full viewport, and exposes the existing sidebar and details
controls as touch-friendly drawers (280px drawer matching the official expanded
sidebar width; the drawer uses horizontal translation only, so opening mobile
mode does not scale the page; the floating nav button hides while a drawer is
open; the top-right panel button opens the right-side panel as a right drawer;
a single session click selects the session and closes the left drawer; backdrop
and nav follow the dark theme). The API and WebSocket URLs are unchanged.
Set `mobileMode: off` in the row config to leave presentation entirely to the
upstream frontend, or use `?dsh_mode=mobile` / `?dsh_mode=desktop` to override
the automatic choice for one page load. `mobileBreakpoint` controls the
automatic cutoff when the shell is enabled.

Or start it explicitly:

```bash
DSH_AUTH_USER=admin DSH_AUTH_PASS='change-me' dsh web --no-open
```

The browser login form sets a 24-hour `HttpOnly` session cookie plus a CSRF
cookie by default. Over HTTPS it uses `__Host-` cookie names, `Secure`, and
`SameSite=Strict`; the legacy names remain only for plain-HTTP LAN
compatibility. The session also expires after 12 hours of inactivity by default,
and its server-side record survives a daemon restart until either timeout is
reached. Normal logout revokes only the current browser session; changing the
password or 2FA settings revokes every session and closes every active WebSocket.
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
edits the username, password, realm, and optional TOTP 2FA. It also lists valid
browser sessions with creation time, last activity, remote address, and client
User-Agent; each row can be revoked independently. Revoking the current row
returns the browser to login. Saving writes the `auth-webserver` namespace of
`$DSH_HOME/settings.yaml` (the password and TOTP secret are secret-role fields:
they never leave the Host unredacted). Public Host/Origin policy, HTTPS
enforcement, proxy trust addresses, rate limits, and session lifetimes belong
in the deployment row or environment, not in the browser settings card. The card
also lists registered Passkeys and can add or revoke them. Adding or revoking a
Passkey requires the current gateway password and, when enabled, the current TOTP
code.

### Edit the full settings document remotely

When Settings is served through this gateway, **Open configuration file** becomes
**Edit configuration file**. The auth-webserver client owns the in-app editor
above the DSH Settings sheet; File Explorer is neither required nor involved.

This is a full-document action: `$DSH_HOME/settings.yaml` can contain API keys,
the gateway password, and the TOTP secret. Opening requires the existing
logged-in cookie session; saving requires that session plus the gateway CSRF
value. It intentionally does not request the password or TOTP a second time.
Reads and saves are `no-store`; saves validate that the document is a YAML
mapping, use a content revision to reject conflicts, and coordinate with the
settings provider through its file lock and atomic replacement.

The editor owns no caller-selected path. Its only backend route is:

```text
GET/POST  /_dsh/auth-webserver/settings-editor/document
```

For a deliberately trusted LAN, deployment configuration may set
`allowInsecureSettingsEditor: true`. This opt-in keeps the logged-in session
and CSRF protection, but **does not encrypt the complete configuration**; the
in-app modal displays a transport warning. Never enable it for a public or
untrusted network. Saving a change to gateway credentials or 2FA can revoke
the editor's session shortly afterwards. Prefer an HTTPS reverse proxy or
SSH/desktop editing.

The card uses these authenticated routes:

```text
GET  /_dsh/auth-webserver/clients
POST /_dsh/auth-webserver/clients/revoke  { "clientId": "..." }
GET  /_dsh/auth-webserver/passkeys
POST /_dsh/auth-webserver/passkeys/register/options
POST /_dsh/auth-webserver/passkeys/register/verify
POST /_dsh/auth-webserver/passkeys/revoke  { "credentialId": "..." }
```

The revoke request requires the browser session's CSRF header. Revoking a
client tears down its active WebSocket and makes its Cookie invalid immediately.

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
    mobileMode: 'auto'
    mobileBreakpoint: 760
    allowedHosts: ['dsh.yiln.de']
    allowedOrigins: ['https://dsh.yiln.de']
    trustedProxyAddresses: ['192.0.2.10']
    requireHttps: true
    # Default false. Set true only for a physically trusted LAN; it exposes
    # the full settings document and step-up credentials over plain HTTP.
    allowInsecureSettingsEditor: false
    passkeyRpName: 'DeepSeek Harness'
    passkeyRpId: 'dsh.yiln.de'
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
disposal. Session records are kept in the owner-only
`$DSH_HOME/plugins/dsh-plugin-auth-webserver/sessions.json`; bearer Cookie
values are never written to disk. Passkey public credentials are stored separately
in the owner-only `passkeys.json`; private keys never leave the authenticator. A
daemon restart closes live WebSockets but leaves unexpired session records usable.

The index and login pages link the manifest, favicon, and iOS
`apple-touch-icon`. The gateway serves the manifest, standard PNG icons, and
`/sw.js` before authentication so Chromium and iOS can inspect the install
metadata. The service worker is deliberately pass-through and never caches
private DSH responses; authentication, session cookies, APIs, and WebSockets
remain enforced after installation. On iOS Safari use Share > Add to Home
Screen; Android/Chromium also needs an HTTPS origin.