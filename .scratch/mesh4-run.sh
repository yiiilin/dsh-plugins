#!/usr/bin/env bash
# One rehearsal, start to finish.
#
# Restarting nodes by hand and probing them one at a time made every iteration slow and
# every result suspect: a probe that ran before the tunnels settled looked like a routing
# failure, and a node left running from a previous attempt answered on a stale connection.
# This script does the whole cycle deterministically so a result means something.
set -u

H=/tmp/mesh4
SRC=/usr/local/src/project/dsh-plugin/pkgs/gateway
WAIT_SETTLE=${WAIT_SETTLE:-25}

stop_all() {
  ps -eo pid,cmd | grep -E "profile n[1-4] " | grep -v grep | awk '{print $1}' \
    | while read -r pid; do kill -9 "$pid" 2>/dev/null; done
  sleep 3
}

deploy() {
  for p in n1 n2 n3 n4; do
    D=$H/profiles/$p/node_modules/@yiln-dsh/dsh-gateway
    cp -a "$SRC/index.js" "$SRC/tools.js" "$D/" 2>/dev/null
    cp -a "$SRC/lib/." "$D/lib/"
  done
}

boot() {
  rm -f "$H"/n*.log
  ( cd "$H/profiles/n1" && setsid env DSH_HOME=$H timeout 600 dsh --profile n1 \
      --no-open --port 3301 > "$H/n1.log" 2>&1 </dev/null & )
  sleep 18
  for n in n2 n3 n4; do
    port=$((3300 + ${n#n}))
    ( cd "$H/profiles/$n" && setsid env DSH_HOME=$H timeout 600 dsh --profile "$n" \
        --no-open --port "$port" > "$H/$n.log" 2>&1 </dev/null & )
    sleep 11
  done
  sleep "$WAIT_SETTLE"
}

report() {
  echo '--- topology as the root sees it'
  grep -hE '^ENVS=' "$H/n1.log" | tail -1
  if [ -n "${port:-}" ]; then
    echo '--- panel view (what the UI renders)'
    curl -sS -m 8 -H 'x-dsh-federation: tunnel' "http://127.0.0.1:4201/admin/state" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.environments||[]).map(e=>`${e.id}=${e.online?"up":"down"}`).join(" "))}catch{console.log("unreadable")}})'
  fi
  echo '--- relay port'
  local port
  port=$(grep -oE 'relay for "n4" listening on 127.0.0.1:[0-9]+' "$H/n1.log" | grep -oE '[0-9]+$' | tail -1)
  echo "port=${port:-none}"
  if [ -n "${port:-}" ]; then
    echo '--- raw bytes through the relay'
    node "$(dirname "$0")/probe-relay.mjs" "$port" 2>&1 | tail -2
  fi
  echo '--- per node'
  for n in n1 n2 n3 n4; do
    printf '%s lines=%s errors=%s\n' "$n" "$(wc -l < "$H/$n.log")" "$(grep -ciE 'fatal|uncaught' "$H/$n.log")"
  done
  echo '--- routing trace'
  grep -hE 'openStream to|forwarding|arrived stream|relay (accepted|opening|to "n4")' \
    "$H/n1.log" "$H/n2.log" "$H/n3.log" "$H/n4.log" 2>/dev/null | tail -12
}

case "${1:-all}" in
  stop) stop_all ;;
  all) stop_all; deploy; boot; report ;;
  report) report ;;
esac
