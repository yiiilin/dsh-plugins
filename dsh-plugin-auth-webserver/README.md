# @yiln-dsh/dsh-plugin-auth-webserver

A DSH `dsh.bundle` that keeps the stock webserver untouched and adds an
**auth-gated reverse proxy** for LAN access:

- the stock `dsh web` server stays on `127.0.0.1:3080` (loopback, no auth);
- this bundle listens on every **non-loopback NIC address** at the same port
  (e.g. `192.168.1.5:3080`);
- it requires HTTP Basic Auth or an HMAC login cookie;
- every accepted request — including WebSocket upgrades — is proxied to the
  stock `127.0.0.1:3080` server.

So the default web module is a *new* module instead of a replacement: local
access behaves exactly like stock DSH, and LAN clients get the full GUI behind
authentication.

## Install

The published package is `@yiln-dsh/dsh-plugin-auth-webserver@0.2.0`.

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
dsh plugin --profile web add ./yiln-dsh-dsh-plugin-auth-webserver-0.2.0.tgz
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
dsh plugin --profile web add @yiln-dsh/dsh-plugin-auth-webserver@0.2.0
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
  "version": "0.2.0"
}
```

Semantic versioning is recommended:

- `0.2.0` -> `0.2.1` for a bug fix
- `0.2.0` -> `0.3.0` for a backward-compatible feature
- `0.2.0` -> `1.0.0` for a breaking change

The selected version is used for:

- npm registry resolution, e.g. `@yiln-dsh/dsh-plugin-auth-webserver@0.2.0`
- the generated tarball name, e.g. `yiln-dsh-dsh-plugin-auth-webserver-0.2.0.tgz`
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
AUTH_PASS='change-me'
```

Or start it explicitly:

```bash
DSH_AUTH_USER=admin DSH_AUTH_PASS='change-me' dsh web --no-open
```

The browser login form sets a 7-day HttpOnly cookie. CLI and automation clients
can use a standard Basic Auth header against a LAN address:

```bash
curl -u admin:'change-me' http://192.168.1.5:3080/
```

## Configure from the Web GUI

Settings > Plugins > Plugin configuration has an "Auth webserver" card that
edits the username, password and realm. Saving writes the `auth-webserver`
namespace of `$DSH_HOME/settings.yaml` (the password is a secret-role field:
it never leaves the Host unredacted). The `AUTH_*` env vars outrank it, and
the `webserver-auth` row config acts as the base layer until you save an
override. Leave the password field empty to keep the current password.

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