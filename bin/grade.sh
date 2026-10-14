#!/bin/bash
# Read the day's written-on sheet back off the Supernote and score the recall rows.
#
# Run by the scheduler in the evening, once the sheet has had all day to be written
# on. Exits non-zero only on a real failure: a sheet that was never written on, or a date
# with no recall rows, is an ordinary outcome and exits 0 quietly. Alarming on those would
# train the alarm to be ignored, and this job's whole value is that it runs unattended.
set -euo pipefail

# launchd gives no login shell, so Homebrew is not on PATH.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")/.."

# Take any work done elsewhere before grading. Grading appends to the review log, and
# replaying a stale log would compute the wrong intervals.
# State is synced through git when this checkout has a remote: pull before grading so a
# position advanced on another machine is not replanned. A fork with no remote skips it.
if git remote get-url origin >/dev/null 2>&1; then
  git pull --quiet --rebase --autostash
fi

# Compile first: a stale dist after a git pull would run yesterday's code silently.
npx tsc

# The last seven days, oldest first. Grading is idempotent by date, so a fully graded day
# is a local no-op. A day not yet finished (not delivered, not written on, unreadable)
# downloads its note again, and a degraded day re-queries the recognisers. Seven rather
# than two because a day graded without the full recogniser pair is marked degraded and
# re-graded here once both answer again, and a sheet finished late is still picked up.
#
# One failing date must not cost the others, nor the commit below: under `set -e` a cloud
# 5xx on the oldest day would otherwise skip today and leave verdicts uncommitted. The
# failure is remembered and turned into the exit status at the end, so it still alarms.
status=0
for days_ago in 6 5 4 3 2 1 0; do
  grade_date="$(date -v-"${days_ago}"d +%F)"
  node dist/cli.js grade --date="$grade_date" || {
    echo "grading $grade_date failed"
    status=1
  }
done

# A verdict is only real once it is committed. state/reviews.json is the whole of recall's
# memory — every interval is replayed from it — and it is append-only with no undo, so
# losing it to an uncommitted working tree loses the schedule itself.
if ! git diff --quiet -- state/; then
  git add state/
  git commit --quiet -m "State: graded $(date +%F)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  if git remote get-url origin >/dev/null 2>&1; then
    git push --quiet origin HEAD:main
    echo "state committed and pushed"
  else
    echo "state committed (no remote configured)"
  fi
else
  echo "state unchanged"
fi

exit "$status"
