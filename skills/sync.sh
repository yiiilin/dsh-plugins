#!/usr/bin/env bash
# Keep the two copies of a skill in step.
#
#   ~/.agents/skills/<name>/   is what the harness loads — edits here take effect
#                              immediately, with no restart.
#   skills/<name>/             is this repo's versioned record, and what gets committed.
#
# The live copy leads, so the direction is live -> repo. Run this, then commit.
#
#   ./skills/sync.sh              # every skill in this directory
#   ./skills/sync.sh <name>       # just one

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
live_root="${HOME}/.agents/skills"

sync_one() {
  local name="$1" live="${live_root}/$1" repo="${here}/$1"
  if [ ! -d "$live" ]; then
    echo "skip ${name}: not installed at ${live}" >&2
    return 0
  fi
  mkdir -p "$repo"
  rsync -a --delete "${live}/" "${repo}/"
  echo "synced ${name}: live -> repo"
}

if [ $# -gt 0 ]; then
  sync_one "$1"
else
  for dir in "${here}"/*/; do
    [ -f "${dir}SKILL.md" ] || continue
    sync_one "$(basename "$dir")"
  done
fi
