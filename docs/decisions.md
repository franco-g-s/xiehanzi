# Key decisions

The calls that shaped the system, and why. Detail and evidence live in the specs.

## Production is measured separately from recognition (2026-08-19)

Anki says most of an HSK 1–3 deck is mature, yet most of those characters can't be written
from memory. So writing proficiency gets its own state and is never inferred from Anki
intervals. → [design](superpowers/specs/2026-08-19-xiehanzi-design.md)

## Glyphs are drawn from stroke data, not set in a font (2026-08-19)

The model glyph and the stroke-order filmstrip are both rendered as
SVG paths from `hanzi-writer-data`, so they are guaranteed to be the same shape. A font beside
a separate stroke diagram cannot promise that, and a mismatch would teach wrong stroke forms.
The outlines descend from AR PL UKai, so they are already 楷体. → [design](superpowers/specs/2026-08-19-xiehanzi-design.md#glyph-rendering--one-source-of-truth)

## A native `.note` notebook, not a PDF — and `PAGESTYLE` must name a built-in (2026-08-20)

The sheet is generated as a real Supernote notebook, so it is written in natively and syncs
back as one file. The device treats `PAGESTYLE` as a lookup, not a label: a custom name hangs
the note on "loading", and a built-in one later gets its background replaced by the device's
own blank. So pages name a built-in style and the sheet is drawn as ordinary ink in `LAYER1`.
→ [design, delivery as built](superpowers/specs/2026-08-19-xiehanzi-design.md#as-built-2026-08-20-onward)

## Unattended delivery is idempotent (2026-08-20)

The morning job runs with nobody watching, so every step must be safe to retry. Notes are
byte-reproducible from the sheet name, an existing sheet is reproduced rather than replanned,
and `push` compares md5 checksums and does nothing when the file is already there. Replacing a
remote file is a compare-and-swap that refuses if the notebook was written on since.
→ [design, delivery as built](superpowers/specs/2026-08-19-xiehanzi-design.md#as-built-2026-08-20-onward)

## The HSK 3.0 handwriting list bounds recall (2026-08-21)

HSK 3.0 lists 3,000 characters to recognise but only 1,200 (手写字表) to write by hand. A
character enters recall only if it has been drilled **and** is in that list; asking for a
character the standard never asks you to write manufactures failures that mean nothing.
→ [recall](superpowers/specs/2026-08-21-recall-system-design.md#the-pool)

## Recall has its own SM-2 schedule, fed only by evidence (2026-08-21)

Copying is not recall, so drill history cannot stand in for recall ability. Recall runs SM-2
(1d → 3d, then `interval × ease`) over an append-only review log, and the schedule is replayed
from that log rather than stored, so it can never drift from the evidence. Not FSRS: there is
no history to train it on, and SM-2 can explain any due date in one sentence.
→ [recall](superpowers/specs/2026-08-21-recall-system-design.md#scheduling)

## Nothing is self-reported (2026-08-21)

Franco's requirement: *"it shouldn't ask me to verify, since the whole point would be that I
don't need to get involved."* A sheet with no ink records nothing rather than failing every
row, so an unopened morning carries items forward instead of corrupting the schedule, and
grading a date twice is a no-op. The one thing asked of him is printed on the page: one
attempt in cell 1, mistakes left standing. → [recall](superpowers/specs/2026-08-21-recall-system-design.md#the-first-cell-protocol)

## Grade from pen strokes in `TOTALPATH`, not page pixels (2026-10-01)

The `.note` file stores every pen stroke in order, so grading can use online handwriting
recognition, which reads the trajectory and is far more accurate for Chinese than reading a
picture. On a 101-cell labelled benchmark the device's own transcription plus an
ink-presence fallback made 27 errors, and the fallback alone had passed 41 wrong answers since
2026-09-15.
→ [stroke grading](superpowers/specs/2026-10-01-stroke-recognition-grading-design.md#what-the-investigation-found)

## Google's recogniser plus a stroke-count gate; vision partner off (2026-10-01)

On the 101-cell benchmark Google's handwriting recogniser alone made 6 errors, and paired with
grok-4.6 as a vision partner, 3. But on Franco's real history the partner vetoed 30 Google
passes, 20 of them correct, and only 4 were real errors — 3 of which a stroke-count check
also catches (correct cells: 401 at delta 0, 11 at ±1, none ≥2 off; wrong cells: 2, 3, 6).
So the shipped default is Google plus a gate failing any pass more than one stroke off the
reference, with the partner off: 5 errors in 126 cells, no model calls, no cost.
→ [stroke grading](superpowers/specs/2026-10-01-stroke-recognition-grading-design.md#stroke-count-gate-and-partner-modes-2026-10-01)

## A confusion fails both characters (2026-10-01)

Writing 作 for 做 fails 做, but it also shows 作 is not reliably recalled. So when two
witnesses agree a different, recall-eligible character was written, that character gets a
fail too. Radicals and partial characters never qualify, and the rule applies only from
2026-10-01 on, not retroactively. → [stroke grading](superpowers/specs/2026-10-01-stroke-recognition-grading-design.md#verdicts)

## One sheet at a time (2026-10-04)

If yesterday's sheet came back with no ink, or never reached the cloud, no new sheet is
made: the unwritten one is carried — renamed to today on the cloud, locally and in the
manifest — so the device never holds two blank sheets under different dates. Grading still
tries the old name, in case ink was waiting to sync. → [design, delivery as built](superpowers/specs/2026-08-19-xiehanzi-design.md#as-built-2026-08-20-onward)
