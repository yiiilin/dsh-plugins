#!/usr/bin/env bash
# Independent deployment task for the web profile: pack the workspace, install
# the tarball into the live profile, restart the daemon, health-check, and roll
# back on failure.
#
# This MUST run as a transient systemd unit (systemd-run), never as a child of
# the dsh-web daemon: restarting dsh-web kills every process in its cgroup,
# including the agent session that would otherwise be waiting on this script.
set -uo pipefail

# A transient systemd unit does not inherit the interactive PATH, so name the
# toolchain explicitly (node/npm/dsh live under this nvm prefix).
export PATH="/root/.nvm/versions/node/v24.14.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

PROFILE_DIR=/root/.dsh/profiles/web
UNIT=dsh-web.service
WORKSPACE=/usr/local/src/project/dsh-plugin
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT=/root/.dsh/artifacts/desktop-vnc-$STAMP
LOG=$BACKUP_ROOT/deploy.log

mkdir -p "$BACKUP_ROOT"
exec > >(tee -a "$LOG") 2>&1

echo "== desktop-vnc deployment $STAMP =="
echo "path: $(command -v node) $(command -v npm) $(command -v dsh)"

health() {
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3080/ 2>/dev/null)
    if [ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "401" ]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# ---- 1. build the tarball in the workspace -------------------------------
cd "$WORKSPACE" || exit 1
echo "-- building client bundle"
npm run build || { echo "FATAL: build failed"; exit 1; }
echo "-- packing"
# Pack into a version-derived name inside the backup directory. A `file:` dep is
# resolved through the lockfile, so installing the SAME path twice can report
# "Already up to date" and project nothing; the stamped copy plus the explicit
# remove below is what forces a real re-projection.
TARBALL=$(npm pack --silent --pack-destination "$BACKUP_ROOT" 2>/dev/null | tail -1)
if [ -z "${TARBALL:-}" ] || [ ! -f "$BACKUP_ROOT/$TARBALL" ]; then
  echo "FATAL: npm pack produced no tarball"
  exit 1
fi
PACKED="$BACKUP_ROOT/$TARBALL"
echo "packed: $PACKED"

# ---- 2. back up the current install --------------------------------------
CURRENT=$(node -e "const p=require('$PROFILE_DIR/package.json');console.log(p.dependencies['@yiln-dsh/dsh-plugins']||'')" 2>/dev/null)
echo "current dependency: $CURRENT"
cp "$PROFILE_DIR/package.json" "$BACKUP_ROOT/package.json.bak"
cp "$PROFILE_DIR/cordis.patch.yml" "$BACKUP_ROOT/cordis.patch.yml.bak" 2>/dev/null || true
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then cp "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_ROOT/pnpm-lock.yaml.bak"; fi

# ---- 3. remove the projected package, then install the fresh tarball -----
echo "-- removing projected package"
rm -rf "$PROFILE_DIR/node_modules/@yiln-dsh/dsh-plugins"
echo "-- installing tarball"
dsh plugin --profile web add "file:$PACKED" 2>&1 | tail -20
INSTALL_RC=${PIPESTATUS[0]}

if [ "$INSTALL_RC" -ne 0 ]; then
  echo "FATAL: install failed (rc=$INSTALL_RC); restoring backup"
  cp "$BACKUP_ROOT/package.json.bak" "$PROFILE_DIR/package.json"
  [ -f "$BACKUP_ROOT/pnpm-lock.yaml.bak" ] && cp "$BACKUP_ROOT/pnpm-lock.yaml.bak" "$PROFILE_DIR/pnpm-lock.yaml"
  exit 1
fi

# ---- 4. verify the composed tree carries the new row ---------------------
echo "-- composed config check"
if ! dsh --profile web --dump-config 2>/dev/null | grep -q 'desktop-vnc'; then
  echo "FATAL: composed profile has no desktop-vnc row; rolling back"
  cp "$BACKUP_ROOT/package.json.bak" "$PROFILE_DIR/package.json"
  [ -f "$BACKUP_ROOT/pnpm-lock.yaml.bak" ] && cp "$BACKUP_ROOT/pnpm-lock.yaml.bak" "$PROFILE_DIR/pnpm-lock.yaml"
  rm -rf "$PROFILE_DIR/node_modules/@yiln-dsh/dsh-plugins"
  dsh plugin --profile web add "file:$CURRENT" >/dev/null 2>&1
  systemctl restart "$UNIT"
  exit 1
fi
echo "composed row present"

# ---- 5. restart and health-check -----------------------------------------
echo "-- restarting $UNIT (this ends the calling agent session)"
systemctl restart "$UNIT"
if health; then
  echo "SUCCESS: daemon healthy after restart"
  echo "SUCCESS $STAMP $PACKED" > "$BACKUP_ROOT/RESULT"
  exit 0
fi

echo "FATAL: health check failed; rolling back"
cp "$BACKUP_ROOT/package.json.bak" "$PROFILE_DIR/package.json"
[ -f "$BACKUP_ROOT/pnpm-lock.yaml.bak" ] && cp "$BACKUP_ROOT/pnpm-lock.yaml.bak" "$PROFILE_DIR/pnpm-lock.yaml"
rm -rf "$PROFILE_DIR/node_modules/@yiln-dsh/dsh-plugins"
if [ -n "$CURRENT" ]; then dsh plugin --profile web add "$CURRENT" >/dev/null 2>&1; fi
systemctl restart "$UNIT"
if health; then echo "ROLLED BACK, healthy" > "$BACKUP_ROOT/RESULT"; else echo "ROLLBACK FAILED — MANUAL INTERVENTION" > "$BACKUP_ROOT/RESULT"; fi
exit 1
