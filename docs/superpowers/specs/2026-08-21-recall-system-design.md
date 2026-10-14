# Recall System — Design Spec

**Date:** 2026-08-21
**Status:** implemented. Grading was later rebuilt on pen strokes; see
`2026-10-01-stroke-recognition-grading-design.md`.
**Extends** `2026-08-19-xiehanzi-design.md`.

## Context

The drill sheet teaches a character by having you copy it ten times with the model in
view. That builds the motor pattern. It does not test whether you can produce the
character when nothing is in front of you, which is the skill that actually matters and
the one the HSK handwriting papers examine.

This spec adds the second half: a scheduled test of **writing from memory**, graded
without asking Franco to report on himself.

### Governing insight

The 2026-08-19 spec established that Anki measures recognition while this project trains
production, so the two keep separate state. The recall system draws the same line one
level deeper:

**Copying is not recall, so drill history cannot stand in for recall ability.** A
character drilled ten times yesterday may still be unrecoverable today. Recall therefore
keeps its own schedule, fed only by evidence of actual retrieval.

### The constraint that shapes everything

Franco's requirement: *"it shouldn't ask me to verify, since the whole point would be
that I don't need to get involved."* Every design decision below follows from grading
having to be automatic. Most importantly it forces **cue uniqueness** — a cue admitting
two correct answers makes the grader mark a right answer wrong, and those false failures
feed straight into the schedule.

## Scope

**In:** recall row rendering, the pool, the SM-2 schedule, read-back grading, and the
relearn loop back into drilling.

**Out:** whole-word recall beyond gap-fill (the gap already covers 晚上 by blanking both
characters), image description, sentence copying.

## Decisions

| Area | Decision |
|---|---|
| Cue | Gap-in-context (`城＿  chéngshì · city`), `cueStyle` toggle to plain meaning+pinyin |
| Pool | Drilled at least once **and** in the 1,200-character 手写字表 |
| Algorithm | SM-2, steps 1d → 3d, then `interval × ease`; ease 1.3–2.8 |
| State | Append-only review log; schedule **derived by replay** |
| Capacity | `recallPages` config decides how many; the schedule decides which |
| Page order | recall → solutions → drill |
| Graded cell | **Cell 1 only** |
| Grading | Transcription, falling back to ink presence |
| Relearn | Two lapses re-queues the character onto a drill sheet |

## The pool

A character is eligible when **both** hold:

1. It has appeared on a drill sheet. That is the only evidence it was ever taught.
2. It is in the 手写字表, the 1,200 characters HSK 3.0 expects you to write by hand.

Rule 2 is a membership test, not a test of why the character was selected. 城 arrived
from Anki class vocabulary but is in the handwriting list, so it is eligible; 避 and 厕
are not in the list and are never tested, however often they are drilled. Against the
current history this admits 34 of 36 drilled characters.

Reading-only characters are excluded because asking Franco to write a character the
standard never asks him to write manufactures failures that mean nothing.

## Scheduling

Learning steps **1d → 3d**, then `interval × ease`. A pass raises ease by 0.1 to a
ceiling of 2.8; a failure resets the interval to one day, drops ease by 0.2 to a floor of
1.3, and increments the lapse count.

Ease moves only **after graduation** — passing the 1d and 3d steps advances the step
without touching it. An item cannot inflate its ease by clearing the two easiest reviews
it will ever get. A failure during the steps returns the item to the first step, and
counts as a lapse.

**Not FSRS.** FSRS needs a trained model and a review history that does not exist yet.
SM-2 is transparent: for any item due today you can say in one sentence why.

### State is a log, not a snapshot

`state/reviews.json` is append-only — one record per graded row,
`{date, char, result, evidence}` where `result` is `pass` or `fail` and `evidence` is
`transcription` or `ink`. Intervals, ease, and due dates are **replayed** from it on
demand and never stored.

There is no `not-attempted` result. An unattempted row appends nothing at all, so the
absence of a record is what carries the item forward — a state that cannot be written
wrong because it is never written. `evidence` is not used by the schedule; it is recorded
so the accuracy of the two grading paths can be compared later against real history.

```json
{
  "version": 1,
  "reviews": [
    {"date":"2026-08-22","char":"市","result":"pass","evidence":"transcription","read":"市"},
    {"date":"2026-08-22","char":"避","result":"fail","evidence":"transcription","read":"辟"},
    {"date":"2026-08-22","char":"城","result":"pass","evidence":"ink"}
  ]
}
```

`read` records what the recogniser actually returned, and is absent for ink verdicts. It
is what makes a misread diagnosable months later instead of appearing as an unexplained
run of failures.

Replay produces this, in memory only, never on disk:

```ts
type Schedule = {
  char: string;
  due: string;           // ISO date
  intervalDays: number;
  ease: number;          // 1.3 – 2.8
  step: number | null;   // null once graduated
  reps: number;
  lapses: number;
};
```

This follows `src/state/sheets.ts`, where linear position is derived from the manifests for
the same reason: two copies of one fact drift, and a drifted schedule silently stops
testing a character for weeks without any visible symptom. Replay over a few thousand
records is free, gives a complete audit trail, and means a change to the algorithm
re-derives every schedule instead of stranding the existing ones on the old one.

### Capacity

`recallPages × recallRowsPerPage` sets the number of rows. Due items sort most-overdue
first, then oldest; the overflow carries to tomorrow and sorts to the front.

`recallRowsPerPage` is its own number, not the drill sheet's 9. A recall row carries a
one-line cue and six cells where a drill row carries a filmstrip, a header, an example
line and ten cells, so it is shorter and more of them fit. It is derived from the recall
row's own height by the same method `layout.ts` already uses, and the two row types share
the page box but nothing else.

This splits a decision that looks like one: **the schedule picks which items, the config
picks how many.** It is Anki's maximum-reviews-per-day, and it keeps the morning a
predictable length. The anticipated later shift — as new intake tails off and
consolidation takes over — is a two-line config change:

```
now:    recallPages: 1, drillPages: 2
later:  recallPages: 2, drillPages: 1
```

## The sheet

Page order is **recall → solutions → drill**, four pages at the current settings.

```
┌────────────────────────────────────────────────┐
│ 城＿  chéngshì · city      ▣ ▢ ▢ ▢ ▢ ▢         │
│ ＿＿  wǎnshang · evening   ▣ ▢ ▢ ▢ ▢ ▢         │
└────────────────────────────────────────────────┘
   ▣ graded    ▢ free practice
```

**Recall comes before drilling** for three reasons, in descending weight. It is the page
that produces the scheduling signal, and on a rushed morning whatever comes first is what
gets done — a skipped drill page costs a day of intake, a skipped recall page costs the
scheduler its input. Retrieval also wants a fresh brain; measured after eighteen rows of
copying it records fatigue. Finally it makes contamination structurally impossible: if a
relearn item ever lands on the same day's drill pages, drilling first hands over the
answer. Ordering the pages this way means there is no rule to enforce and none to forget.

**Only cell 1 is graded.** After checking the solutions page Franco writes the correct
character in the remaining cells. Grading every cell would read that correction and score
the failure as a pass. This single rule is what keeps the data honest, and it is why the
ink-presence fallback works at all.

### The first-cell protocol

Cell 1 is a **commitment**: one attempt, never erased, never corrected. A wrong character
is left standing and the correction goes in cell 2 onward. Leaving cell 1 blank is the
honest way to say "I could not recall it".

This is the one thing the system asks of Franco, and every verdict rests on it — an
erased-and-rewritten first cell reads as a pass on a character that was actually
forgotten, and nothing downstream can detect that. It is therefore **printed on the recall
page** rather than left to memory:

```
第一格只写一次 · first cell: one attempt, leave mistakes standing
```

The sheet teaching its own protocol costs one line of text and removes the only failure
mode the design cannot otherwise defend against.

Six cells rather than the drill row's ten: one attempt, plus room to reinforce after
checking.

### Cue format

Primary: blank the target inside an HSK graded example word and cue with the whole word's
pinyin and meaning. The target may be one character (`城＿`) or the whole word (`＿＿`),
so multi-character recall needs no separate mechanism. Example words already come from
`src/select/enrich.ts`.

Fallback for characters with no example word: the bare character's meaning and pinyin.

`cueStyle: 'gap' | 'plain'` switches the whole sheet to the plain form. The toggle exists
because the choice between the two is a question about how it feels to use, which a week
of real sheets answers and speculation does not.

## Grading

`grade --date=YYYY-MM-DD` pulls the note from Supernote Cloud, decodes each page, and
compares cell 1 of each recall row against the expected answer.

### Reading the transcription

> Superseded by the 2026-10-01 stroke-recognition spec, which grades from pen strokes. Kept
> because the device transcription survives as the last-resort tier.

`RECOGNTEXT` in a page's metadata holds the absolute offset of a length-prefixed block
containing **base64-encoded JSON**:

```json
{"elements":[{"label":"我叫陆豪","type":"Text","words":[
  {"label":"我","bounding-box":{"x":39.39,"y":25.62,"width":7.49,"height":9.69}}, …
]}],"type":"Raw Content"}
```

Boxes are in millimetres, so they map onto the layout's own geometry directly. Each
character's **box centre** selects the cell containing it — centres are robust to the
size variation between a cramped 一 and a sprawling 豪 in a way that edges are not.

One wrinkle observed in real data: a `words` entry may carry several characters under a
single box (你好 at 24.0 mm wide, 机机 at 24.5 mm). Where a label is longer than one
character its box is divided evenly across x.

### Evidence ladder

> Superseded by the 2026-10-01 spec: the "ink in cell 1 is a pass" rung turned out to pass
> wrong answers, and was removed. The blank-cell-1 fail rule and carry-forward survive.

| Evidence | Verdict |
|---|---|
| Transcription covers the row | Grade the character — pass or fail |
| No transcription, ink in cell 1 | **Pass**, assumed correct |
| No transcription, page has ink, cell 1 blank | **Fail** — the solutions page was consulted |
| No ink anywhere on the page | Not attempted — stays due, carries forward |

The third row is what makes the fallback work. Failing to recall a character produces a
blank first cell followed by ink in the rest, because the natural response is to check the
answer and then write it. Ink presence confined to cell 1 therefore separates *recalled*
from *could not recall* without reading anything.

What it cannot catch is a **confidently wrong** answer — 买 written for 卖, or the right
character with a wrong component. That is the only thing transcription buys over ink, and
it is a genuine category in Chinese, but far rarer than blank-versus-filled.

Carry-forward triggers on *no evidence the page was attempted*, never on missing
transcription. A day Franco wrote on but did not transcribe still advances the schedule;
a day he never opened leaves it untouched. This is the no-backlog property requested
separately, and the same geometry applied to drill rows answers "was yesterday's sheet
actually completed" for free.

### Misgrades

The two failure directions are not equally costly, and the asymmetry favours us.

A **false negative** — written correctly, read as something else — costs one shortened
interval, recovered on the next pass. This is the observed mode: 避 was written correctly
and misread as 辟.

A **false positive** — written wrongly, read as the expected character — is the expensive
one, because it silently lengthens the interval on a character Franco cannot write. It is
also much rarer: it requires the misread to land *exactly* on the expected answer, and the
recogniser has no knowledge of what was expected, so nothing biases it in that direction.

**The recogniser signature.** An item that fails three consecutive times with the *same*
`read` value is flagged for review rather than left to spiral. A person who has forgotten
a character writes different wrong things on different days, or nothing at all. A
recogniser misreads the same correctly-written glyph the same way every time. Identical
repeated readings therefore indicate a recognition problem, not a memory problem.

**Visually similar characters are never fuzzy-matched.** The confusable pairs — 买 and 卖,
or a character with one wrong component — are precisely the genuine errors most worth
catching. Tolerance there would mask the highest-value failures the system exists to find.

## The relearn loop

An item that reaches two lapses is queued onto a **drill** sheet with
`reason: 'relearn'`.

This is the join that makes the two halves one system: recall discovers what decayed,
drilling repairs it, and the repaired character re-enters the recall rotation. Without it
a forgotten character is tested at shortening intervals forever and never retaught.

Relearn is deliberately **not same-day**. A character failed this morning reaches a drill
sheet tomorrow, because delivering it today would mean regenerating a sheet already
written on — and `push.ts` refuses that for good reason.

## The manifest records geometry, not just content

Grading needs to know which character occupied which row **and where that row was
printed**. Recomputing the grid from current config at grading time is a latent
corruption: changing `recallPages` or `cueStyle` next week would silently regrade every
earlier sheet against a layout it was never printed with.

So the sheet manifest is extended to describe itself — the recall items in row order, and
the resolved geometry in millimetres:

```ts
type RecallRow = { char: string; cue: string; page: number; row: number };

type SheetLayout = {
  cellMm: number;
  originXMm: number;      // left edge of cell 1
  originYMm: number;      // top edge of row 1
  rowPitchMm: number;
  cellsPerRow: number;
};
```

A manifest then answers "what was asked, and where was it on the page" without consulting
any configuration file. Grading a sheet from a month ago stays correct after any number of
config changes — the same reason `sheets.json` is the record of what was actually
practised rather than a set of parameters for recomputing it.

## Modules

```
src/recall/pool.ts       eligibility — drilled ∩ 手写字表
src/recall/schedule.ts   SM-2 replay over the review log      (pure)
src/recall/grade.ts      transcription + ink → verdicts       (pure)
src/render/recall.ts     recall rows and the solutions page
src/state/reviews.ts     append-only log
src/deliver/note/read.ts note → per-page transcription + ink  (new)
```

`schedule.ts` and `grade.ts` are pure functions over plain data. They are the two places
where a bug corrupts months of scheduling invisibly, so they carry the heaviest test
pressure. Grading sits behind an interface so the transcription path can be replaced
without touching the schedule.

`read.ts` is the inverse of `write.ts` and belongs beside it.

## Testing

- **schedule** — replay determinism; identical logs give identical schedules; a pass
  after a lapse does not restore the old interval; ease respects both bounds; replaying a
  log twice changes nothing.
- **grade** — box centres landing in each cell of a fixture grid; multi-character boxes
  split correctly; a box in the margin belongs to no cell; every rung of the evidence
  ladder; ink in cells 2–6 with cell 1 blank grades as a failure.
- **pool** — reading-only characters never enter, however often drilled; a character
  drilled twice enters once.
- **round trip** — write a note, read it back, recover the same page geometry.
- **end to end** — generate, grade a fixture note, confirm the schedule advanced by the
  expected intervals.

## Risks

**Transcription is unproven on generated notes.** Today's sheet carries
`FILE_RECOGN_TYPE:1` and Franco's handwriting, yet `RECOGNTEXT` is `0` on both pages,
while a device-created note holds a full payload. Either the transcribe button was never
pressed on it, or the device declines to transcribe notes it did not create. **This is
tested before anything depends on it.** The ink fallback covers the failure case, and the
schedule, pool, sheet, and relearn loop are unaffected either way.

**Transcription requires a manual button press.** Even where it works it is not automatic
in the sense of happening unprompted. The ink ladder means a forgotten press costs
accuracy on confidently-wrong answers, not the day's data.

**Six cells may be the wrong number.** Too many if most recalls succeed, too few to
relearn in if they fail. It is config; a week of real sheets settles it.

**Measured accuracy is 15/16** on Franco's real handwriting (避 read as 辟). See
*Misgrades* above for why this is affordable. (A larger sample later showed this was
optimistic; that is what the 2026-10-01 spec answers.)

## Upgrade path — off-device recognition

If transcription proves unreliable and the manual fallbacks grate, recognition can move
off the device, to an always-on machine or the cloud. Recorded here so the option is not rediscovered later.

**The task is easier than it looks: this is verification, not recognition.** The expected
answer is known, the character is isolated in a known cell, and the question is only
whether what was written matches. That is a far weaker requirement than open-vocabulary
handwriting OCR, and it admits cheap solutions that full OCR does not.

Ranked by effort:

1. **macOS Vision** (`VNRecognizeTextRequest`, `zh-Hans`) — built into macOS, no
   dependency, no cost, no network. Weakest on isolated handwritten characters, since it
   is built for document text, but the cheapest thing to try.
2. **A CASIA-HWDB classifier** — the standard Chinese handwriting corpus; a small CNN over
   single isolated characters is well-matched to this exact problem, and cells are already
   cropped for us by the grid geometry. Accept a match in the top-k rather than demanding
   rank 1, since only verification is needed.
3. **Cloud OCR** — Baidu and Tencent handle Chinese handwriting markedly better than the
   Western providers. Costs money and sends handwriting off-device.

Cell images come from the existing bitmap path: `MAINLAYER` decodes to a 1920×2560
bitmap, and the layout already knows every cell's rectangle in millimetres.

## Open questions

None blocking at the time. The transcription test resolved the only material unknown, and
the design held either way. The upgrade path above was taken up in the 2026-10-01 spec.
