#!/bin/bash
# Mirror the Supernote drive and commit the result.
#
# Run by the scheduler. Exits non-zero on any failure so the scheduler can alarm and
# withhold the heartbeat — a backup that quietly stopped running is indistinguishable from
# one that is working, right up until you need it.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")/.."

DEST="${XIEHANZI_BACKUP_DIR:-$HOME/supernote-backup}"

node dist/cli.js backup --dest="$DEST"

# Commit whatever changed, so each run leaves a dated point to recover from rather than
# only the latest state.
cd "$DEST"
if [ ! -d .git ]; then
  git init --quiet -b main
fi
if ! git diff --quiet || [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit --quiet -m "Backup $(date +%F)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  echo "committed changes"
else
  echo "nothing changed"
fi
