#!/usr/bin/env bash
# Build the four-node rehearsal from scratch.
#
# n1 is the root and dials nobody. n2 dials n1. n3 dials n1 and n2. n4 dials n2 and n3.
# That gives two nodes with two upstreams each, and a cycle n1 <- n2 <- n3 <- n4.
#
# Each node needs a registry naming who may connect *to* it, because `accept` refuses an
# unknown token — a middle node cannot relay for a peer it has never heard of.
set -eu

H=/tmp/mesh4
SRC=$(cd "$(dirname "$0")/.." && pwd)/pkgs/gateway
rm -rf "$H" /tmp/pkM
mkdir -p "$H/profiles" /tmp/pkM

for p in n1 n2 n3 n4; do
  mkdir -p "$H/profiles/$p"
  cd "$H/profiles/$p"
  cp /root/.dsh/profiles/main/pnpm-workspace.yaml . 2>/dev/null || true
  echo '@deepseek-ai:registry=https://registry.npmjs.org/' > .npmrc
  python3 - "$p" <<'PY'
import json, sys
json.dump({"name": sys.argv[1], "private": True, "type": "module",
  "dependencies": {"@yiln-dsh/dsh-gateway": "file:/tmp/pkM/gw.tgz"},
  "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@yiln-dsh/dsh-gateway"]}}},
  open('package.json', 'w'), indent=2)
PY
done

cd "$SRC" && npm pack --pack-destination /tmp/pkM >/dev/null 2>&1
mv /tmp/pkM/yiln-dsh-dsh-gateway-*.tgz /tmp/pkM/gw.tgz
for p in n1 n2 n3 n4; do
  ( cd "$H/profiles/$p" && timeout 300 pnpm install --config.dangerously-allow-all-builds=true >/dev/null 2>&1 )
done

tok() { printf 'TOK%s00000000000000000000000000000000' "$1"; }

mkcfg() { # name port role name-label upstreams-json
  cat > "$H/profiles/$1/cordis.patch.yml" <<YAML
- id: webserver-auth
  config: {allowRemoteSettings: true, allowInsecureRemoteSettings: true, allowInsecureSettingsEditor: true}
- id: gateway
  config:
    host: 127.0.0.1
    port: $2
    accept: true
    name: '$4'
    upstreams: $5
    homeDir: $H
    cacheDir: $H/c-$1
    registryPath: $H/env-$1.json
    rootEmbedded: true
    rootPrefix: ''
    selfUnit: ''
    systemdUnit: ''
YAML
}

mkcfg n1 4201 main 'n1-root' '[]'
mkcfg n2 4202 main 'n2-mid'  "[{url: 'http://127.0.0.1:4201', token: '$(tok 2)'}]"
mkcfg n3 4203 main 'n3-leaf' "[{url: 'http://127.0.0.1:4201', token: '$(tok 3)'}, {url: 'http://127.0.0.1:4202', token: '$(tok 3)'}]"
mkcfg n4 4204 main 'n4-tail' "[{url: 'http://127.0.0.1:4202', token: '$(tok 4)'}, {url: 'http://127.0.0.1:4203', token: '$(tok 4)'}]"

reg() { printf '{"environments":[%s]}\n' "$2" > "$H/env-$1.json"; chmod 600 "$H/env-$1.json"; }
env() { printf '{"id":"%s","kind":"remote","label":"%s","enabled":true,"token":"%s"}' "$1" "$1" "$(tok "${1#n}")"; }
reg n1 "$(env n2),$(env n3),$(env n4)"
reg n2 "$(env n3),$(env n4)"
reg n3 "$(env n4)"
reg n4 ''
echo "built $H"
