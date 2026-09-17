#!/usr/bin/env bash
# Install a skill from this repo into the harness's skill root.
#
#   skills/<name>/             is this repo's versioned record — the source.
#   ~/.agents/skills/<name>/   is the installed copy the harness loads.
#
# The repo leads, so the direction is repo -> live. Commit first, then run this.
#
#   ./skills/sync.sh              # every skill in this directory
#   ./skills/sync.sh <name>       # just one

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live_root="${HOME}/.agents/skills"

sync_one() {
  local name="$1" live="${live_root}/$1" repo="${here}/$1"
  if [ ! -f "${repo}/SKILL.md" ]; then
    echo "skip ${name}: no SKILL.md in ${repo}" >&2
    return 0
  fi

  # This overwrites the installed copy, so anything edited there and not yet
  # brought back into the repo is about to be lost. Show it before doing it.
  if [ -d "$live" ]; then
    local drifted
    drifted="$(diff -rq "${repo}" "${live}" 2>/dev/null || true)"
    if [ -n "$drifted" ]; then
      echo "warning: ${name} differs from the installed copy, which this overwrites:" >&2
      echo "${drifted}" | sed 's/^/  /' >&2
    fi
  fi

  install -d "$live"
  rsync -a --delete "${repo}/" "${live}/"
  echo "synced ${name}: repo -> live"
}

if [ $# -gt 0 ]; then
  sync_one "$1"
else
  for dir in "${here}"/*/; do
    [ -f "${dir}SKILL.md" ] || continue
    sync_one "$(basename "$dir")"
  done
fi