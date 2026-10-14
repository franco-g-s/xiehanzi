#!/bin/bash
# Build the day's practice sheet, put it on the Supernote, and persist the progress.
#
# Run by the scheduler. Exits non-zero on any failure so the scheduler can alarm and
# withhold the heartbeat — a sheet that silently stops arriving is the failure mode this
# whole system exists to avoid.
set -euo pipefail

# launchd gives no login shell, so Homebrew is not on PATH.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$(dirname "$0")/.."

# Take any work done elsewhere before planning, or this machine plans against a stale
# position and reprints characters that are already done.
# State is synced through git when this checkout has a remote: pull before planning so a
# position advanced on another machine is not replanned. A fork with no remote skips it.
if git remote get-url origin >/dev/null 2>&1; then
  git pull --quiet --rebase --autostash
fi

# Compile first: a stale dist after a git pull would run yesterday's code silently.
npx tsc

# Grade anything that reached the cloud since last night before planning today's sheet.
#
# The evening job already re-grades yesterday, but it runs at 21:30 — after this morning's
# sheet was planned. A sheet written in the evening and synced overnight would therefore
# not reach the schedule until the FOLLOWING evening, and the sheet in between reprints
# the recall rows it should have retired. Grading here, ahead of planning, is what closes
# that window: the deadline for syncing a written sheet becomes 06:20 the next morning
# rather than 21:30 the same night. (2026-09-22 was written on, synced after 21:31, and
# cost 2026-09-23 a sheet whose recall rows were identical to the day before's.)
#
# Three days rather than one so a weekend's sheets synced together all land, and because
# a verdict appended late still replays in date order — the review log is sorted by date,
# not by the order it was written in. Grading is idempotent by date and a day already
# graded costs nothing: that check is local and returns before any network call.
#
# A failure here must never cost the sheet. Under `set -e` a Supernote 401 — seen
# 2026-09-19 — would abort before `generate` and nothing would be delivered at all, which
# is far worse than a sheet planned on a schedule one day stale. The evening job exits
# non-zero on the same failure and alarms, so warning here is enough; this job's heartbeat
# means the sheet arrived, and it must keep meaning only that.
#
# The `alarm` bound is the other half of that promise, and `||` alone does not give it: a
# cloud call that HANGS never returns a status to tolerate. This job already burned its
# whole 1800 s budget that way once (2026-09-19, exit=124) and delivered no sheet. Since
# stroke grading, a healthy grade is about two minutes (a download plus ~10 vision-model
# calls of ~11 s each), and a day already graded is a local no-op. 300 is a backstop
# against a wedge, not a performance budget, and it must leave room for the sheet: three
# catch-ups at 300 s is 900 s, and the `carry` check below is bounded at 300 s too, leaving
# at least 600 s of the 1800 s job budget for generate and push. The host has no `timeout` binary; `perl alarm` is the substitute.
for days_ago in 3 2 1; do
  catch_up_date="$(date -v-${days_ago}d +%F)"
  perl -e 'alarm 300; exec @ARGV' node dist/cli.js grade --date="$catch_up_date" ||
    echo "warning: catch-up grading of $catch_up_date failed or timed out — planning today's sheet against the schedule as it stands"
done

# A dated marker file `.skip-YYYY-MM-DD` (untracked, ignored by git) means "do not build
# today's sheet" — a manual override that wins over everything below. The marker names a
# date, so it expires by itself and never needs cleaning up.
#
# Otherwise `carry` decides. A new sheet is only made once the last one has been written
# on: if the most recent sheet came back blank (or never reached the cloud), it is renamed
# to today instead — cloud, local copy and manifest — so the device never holds two blank
# sheets under different dates. Franco asked for exactly this on 2026-10-04, after an
# offline weekend left 10-03 and 10-04 both on the device. On a carry, `generate` must not
# run: it would rewrite the renamed local file with today's header, and push would then
# find the cloud copy "different" and leave it alone, the two out of step.
#
# A failure in `carry` falls back to generate and push, as grading above does, because a
# sheet must never be lost to a checker. That fallback is safe at any point of a carry cut
# short: the manifest moves first, so `generate` then reprints the carried sheet under
# today's name rather than planning one the manifest does not describe.
if [ -e ".skip-$(date +%F)" ]; then
  echo "skipping generate/push for $(date +%F): .skip-$(date +%F) is present"
else
  decision="generate"
  if carry_out="$(perl -e 'alarm 300; exec @ARGV' node dist/cli.js carry)"; then
    echo "$carry_out"
    if [ "$(printf '%s\n' "$carry_out" | tail -n 1)" = "decision: carried" ]; then
      decision="carried"
    fi
  else
    echo "$carry_out"
    echo "warning: carry check failed or timed out — generating as usual"
  fi
  if [ "$decision" = "generate" ]; then
    node dist/cli.js generate
  fi
  node dist/cli.js push
fi

# Progress is only real once it is committed. Left in the working tree it survives nothing
# — not a checkout, not a disk — and it silently diverges from every other machine.
#
# The message names the grading as well as the sheet because this commit can now carry
# both: verdicts for a sheet synced overnight land in reviews.json just above. A commit
# labelled only as today's sheet while carrying two-day-old verdicts would make the git
# log a worse record than it was — and that log is how the bug this catch-up fixes was
# dated in the first place.
if ! git diff --quiet -- state/; then
  git add state/
  git commit --quiet -m "State: sheet for $(date +%F), and any grading caught up with it

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
