# dsh-plugin-auth-webserver

A DSH `dsh.bundle` that:

- disables the stock DSH webserver;
- provides a compatible `webServer` service;
- listens on `0.0.0.0:3080` by default;
- requires HTTP Basic Auth or an HMAC login cookie before serving the GUI.

## Install

From the plugin checkout:

```bash
dsh plugin --profile web add /usr/local/src/project/dsh-plugin
```

The profile must already be the `web` profile, and the package must be started
with `dsh web` (or `dsh --profile web`). The stock `dsh web` parser rejects
`--host 0.0.0.0`, so do not pass that flag; this bundle defaults to it.

## Configure

Credentials are resolved in this order:

1. `DSH_AUTH_USER` / `DSH_AUTH_PASS`, or `AUTH_USER` / `AUTH_PASS`
2. the `webserver-auth` row config
3. `$DSH_HOME/plugins/dsh-plugin-auth-webserver/state.json`

The server refuses to listen when no password is configured. Example startup:

```bash
DSH_AUTH_USER=admin DSH_AUTH_PASS='change-me' dsh web --no-open
```

The browser login form sets a 7-day HttpOnly cookie. CLI and automation clients
can use a standard Basic Auth header:

```bash
curl -u admin:'change-me' http://your-server:3080/
```

## Override host or port

Edit `$DSH_HOME/profiles/web/cordis.patch.yml` after installing:

```yaml
- id: webserver-auth
  config:
    host: '0.0.0.0'
    port: 3080
    username: 'admin'
    password: 'your-password'
```
