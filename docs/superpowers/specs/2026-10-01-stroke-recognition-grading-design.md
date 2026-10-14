# Stroke Recognition Grading — Design Spec

**Date:** 2026-10-01
**Status:** implemented.
**Extends** `2026-08-21-recall-system-design.md`. **Replaces** its "Reading the
transcription" and "Evidence ladder" sections, and acts on its "Upgrade path —
off-device recognition".

## Context

Recall grading reads the Supernote's own handwriting transcription and, when a page has
none, falls back to "any ink in the graded cell is a pass". Both are wrong far more often
than the 2026-08-21 spec's 15/16 sample suggested:

- **False fails.** Correctly written characters are transcribed as something else and
  come back on the next sheet. On 2026-09-29, 真 and 还 were written correctly and read
  as 直 and 亻.
- **False passes.** The ink fallback cannot tell a right answer from a wrong one. It
  covered roughly a third of graded cells since 2026-09-15 and passed 41 wrong answers.
- **Confusions are half-graded.** Writing 作 for 做 fails 做 but says nothing about 作,
  even though it shows 作 is not reliably recalled either.

## What the investigation found

The benchmark is 101 recall cells from the sheets of 2026-08-24 to 2026-09-29. Every cell
was labelled correct or wrong by Franco where the recognisers disagreed.

**The `.note` file stores every pen stroke, in order.** Each page's `TOTALPATH` block
holds the strokes as point sequences, alongside the rasterised `MAINLAYER` grading reads
today. Strokes enable *online* recognition, which uses the pen trajectory and is far more
accurate for Chinese than reading a picture. All 3,873 strokes in the benchmark sit on
visible ink, so erased strokes are not left behind in `TOTALPATH`.

| Recogniser | Correct marked wrong | Wrong marked right | Total (of 101) |
|---|---|---|---|
| **Google handwriting (strokes) + grok-4.6 (image)** | 1 | 2 | **3** |
| Google handwriting alone | 1 | 5 | 6 |
| grok-4.6 alone (best vision model on OpenCode Go) | 2 | 7 | 9 |
| Supernote transcription + ink fallback (today) | 17 | 10 | 27 |

Settled while getting there, so it is not re-investigated:

- **Google is the best single reader of what was written.** Its one weakness is snapping
  a malformed character to the nearest real one: 样 written with 禾, a rough 能. Franco
  ruled that a recognisable character with a wrong or missing component is a **fail**.
- **The partner model matters.** Paired with Google, the partner only has to list the
  asked character in its top 3. Totals: grok-4.6 3, kimi-k3 5, glm-5.3-flash 6 (no better
  than Google alone; it trades false passes for false fails), minimax-m3 9. At ~15 cells
  a night grok-4.6 costs about $2/month, ~13% of its Go allowance, and less with the
  call-only-when-it-matters rule below.
- **Ruled out:** Apple Vision (one candidate, misses common characters), HanziLookup
  (breaks on stroke order), majority voting across several vision models (worse than
  Google alone), and accepting the expected character anywhere in Google's top 3
  (it would pass 待 for 持, since 持 is Google's #3 there).
- **OpenCode Go models that are not usable here:**
  - No image input: hy3, hy4-preview, longcat-2.0, minimax-m2.7, glm-5.2, glm-5.3.
  - Blocked by the workspace's privacy settings: the DeepSeek text models need Global
    regions; Muse Spark needs training-on-data consent.
  - Too slow, or hit the per-model 5-hour cap before finishing 101 cells: the Qwen and
    MiMo models, kimi-k2.7-code, longcat-2.5.
  - Go needs an `x-opencode-session` header on every request. ~30 requests a night is
    light.
- **Jev** (TypeSafe AI) is text-only, with no announced vision. The recogniser interface
  below is shaped so a Jev-style vision model can drop in later.

### Partner prompt test (2026-10-01)

The benchmark above asked the partner blind for its top 3. Five partner prompts were then
tested on grok-4.6 over the same 101 labelled cells, plus 20 **decoys**: a correctly
written character re-asked as if a look-alike were the target (a written 待 asked as 持),
where every answer should be "no". The decoys are the bias check: they show whether
telling the model the target makes it "correct" a confusion into the answer. Pipeline =
Google's top 1 is the target **and** the partner accepts.

| Prompt | Correct vetoed /53 | Malformed caught /6 | Pipeline errors /101 | Decoys accepted /20 | $/call |
|---|---|---|---|---|---|
| blind, top-3 rule (the first design) | 0 | 3 | 4 | 4 | ~0.0044 |
| C: blind, refined | 5 | 5 | 7 | 0 | 0.0042 |
| A: reference image, strict | 13 | 6 | 14 | 0 | 0.005 |
| **A′: reference image + handwriting tolerance** | **2** | **6** | **3** | **1** | 0.0048 |
| B: multiple choice (target + look-alikes) | 5 | 5 | 7 | 0 | 0.0057 |

**A′ is adopted.** The partner is no longer blind: it is told the target, shown it printed
in 楷书 from hanzi-writer-data beside the handwriting, told that normal handwriting
variation (joined strokes, proportions, open loops, stroke order) is not an error, and
asked whether the handwriting is that character, written correctly. Showing the target did
not bias it: it accepted 1 decoy in 20, against 4 for the blind prompt.

## Decisions

| Question | Decision |
|---|---|
| Strokes to Google's undocumented endpoint? | Yes, accepted by Franco. Anonymous single-character strokes, no account. |
| Strictness | A wrong or missing component is a fail, even when the character is recognisable. |
| Stroke order | Extracted and documented. **Never** a grading input. |
| Outages | Never fail loudly. Grade with whatever is available, mark it degraded, re-grade later. |
| Load | Sequential, one request at a time. No local models. |
| Past grades | Re-grade every past day with the new recognisers. False passes matter most. |
| Confusion rule | **From 2026-10-01 onward only**, not retroactive. |
| Does the partner see the target? | Yes, as a printed reference beside the handwriting (prompt A′). The decoy test is the bias check. |

## Strokes

New module `src/deliver/note/strokes.ts`, read alongside `read.ts`:

- `TOTALPATH` block: a uint32 stroke count, then per stroke a uint32 length and a record.
  The record's point count is the uint32 at index 53, followed by that many `(a, b)` uint32
  pairs. Further per-point data (pressure and so on) follows and is ignored.
- Device to page millimetres, derived on the Manta and verified against the bitmap:
  `x_mm = (16200 − b) / 8.4375 × 162.6 / 1920`, `y_mm = a / 8.4375 × 216.7 / 2560`.
- The record header is only partly understood, so parse defensively. A stroke whose point
  count does not fit its record length is skipped and counted. A page with no parseable
  strokes is treated as having no stroke evidence; it is not an error.
- A stroke belongs to the cell containing its centroid, using the same `locateCell`
  geometry grading already uses.

The 2026-08-23 sheet yields no strokes for its cells, because it predates today's layout.
Its existing verdicts are kept as they are.

**Stroke order** is the order of strokes in the block, and each stroke has a direction.
That is enough to compare against reference stroke order (for example hanzi-writer data)
later. It is documented in the README as a capability and deliberately **not** used in
grading.

## Recognisers

One interface, so models can be swapped without touching grading:

```ts
type Reading = {
  source: string;
  candidates: string[]; // what was written, ranked, single characters only
  accepts?: boolean;    // set by a recogniser asked about the target: is it the target, written correctly?
};
type Recogniser = {
  name: string;
  recognise(cell: { strokes: Stroke[]; png: Buffer }, target: string): Promise<Reading | null>;
}; // null = unavailable
```

- **`google`**: ignores `target`. POSTs strokes to `inputtools.google.com/request?itc=zh-t-i0-handwrit`. Drops
  multi-character candidates (`和口`, `月日`). 10 s timeout, one retry.
- **`go:<model>`**: an OpenCode Go vision model over chat-completions, messages or
  responses, depending on the model. It **compares** (prompt A′, above):
  - Two images, handwriting first, then the target rendered in 楷书 from hanzi-writer-data
    (183 px, black on white, 10% margin). The prompt names the target, gives both stroke
    counts as a hint, lists learners' typical errors and the handwriting variation that is
    not an error, and asks "is image 1 the character in image 2, written correctly?". A
    target with no reference data makes the partner unavailable.
  - Low reasoning effort. JSON reply with `verdict` (`correct`, `different_character`,
    `malformed`, `incomplete`, `illegible`), `written` and `closest`. `accepts` is
    `verdict === "correct"`; the candidates are `written` then `closest`, with the target
    first on acceptance and removed on rejection. A missing or unknown verdict is
    unavailable.
  - 45 s timeout, one retry. Default model `grok-4.6`, set in `config/recognition.json`.
  - Key from `XIEHANZI_OPENCODE_GO_KEY` in `.env`, falling back to
    `~/.local/share/opencode/auth.json`.
- **`device`**: the existing transcription lookup (in `src/recall/assess.ts`), now only
  the last resort.

Cell images come from the existing `MAINLAYER` decode, cropped with a 1.5 mm margin.

## Verdicts

A pure function: readings, expected character and recall-eligible set in; verdicts out.

**Pass rule.** Using the first available tier:

| Tier | Pass if | Degraded? |
|---|---|---|
| 1 | Google's top 1 is the expected character **and** grok accepts it | no |
| 2 | Google's top 1 is the expected character (grok unavailable) | yes |
| 3 | grok accepts the expected character (Google unavailable) | yes |
| 4 | the device transcription is the expected character | yes |
| — | nothing available: record nothing for the cell; the day is retried | — |

"Accepts" is the partner's `accepts`. A partner reading without one (a recogniser that only
lists candidates) falls back to the original rule: top 3 on tier 1, top 1 on tier 3. A
rejection is evidence even with no candidates ("not a real character"): it is a fail,
never "unavailable".

**The "any ink is a pass" rule is removed.** A row whose graded cell is blank still fails
only if the rest of that row has ink, as today.

**Call only when it matters.** Grok is asked only when Google says pass, or when Google
reads a different recall-eligible character (the confusion rule needs it). On the
benchmark that is about 60% of cells.

**Confusion rule** (from 2026-10-01 on). When a cell fails, the written character also gets
a fail verdict if all of these hold:

- Google's top 1 and grok's top 1 (the character it says was written) are the same,
- it differs from the expected character,
- and it is recall-eligible: in `introducedDates`, so drilled and in the handwriting list.
  Radicals and partial characters (纟, 疒, 亻) never qualify.

Degraded tiers produce no confusion verdicts, since there are not two readers to agree. The
later re-grade of that date adds them.

**One verdict per character per date, and a fail wins.** Today's replay sorts `fail`
before `pass`. A character that both passed as itself and failed as a confusion on the
same day would otherwise end up scheduled as a pass while still counting the lapse.
Verdicts are merged before they are written.

### Stroke-count gate and partner modes (2026-10-01)

Supersedes the tier 1 rule above as the shipped default. On cells Google read as the
target, Franco's written stroke count minus the reference count (hanzi-writer-data):

| | delta 0 | ±1 | ≥2 off |
|---|---|---|---|
| written correctly | 401 | 11 | 0 |
| actually wrong | 2 | 3 | 6 |

On his real history grok-4.6 vetoed 30 Google passes; Franco confirmed 20 of them correct.
Only 4 were real errors Google alone missed, and the stroke count catches 3 of those.

**Decision (Franco):** Google plus the stroke gate, partner off. A Google pass more than
`maxStrokeDelta` (1) strokes off the reference is a fail, in every mode; an unknown delta
(no pen data, no reference) never fails a cell. `partnerMode` in `config/recognition.json`:

- `off` (shipped): never ask the partner. Google and the gate are the whole pipeline, so
  its verdicts are tier 1 and not degraded, and `regrade` needs only Google.
- `ambiguous`: ask only about a Google pass exactly one stroke off; the partner decides
  those. Needed but unavailable: Google and the gate decide, degraded. The next test.
- `always`: the rule above, plus the gate.

With the partner not asked, the confusion rule's second witness is the stroke count: the
character Google read counts as written only if its own reference count is within
`maxStrokeDelta` of the strokes written. Without Google, every mode falls back to the
partner alone (tier 3, degraded), then the device transcription. No mode asks the partner
about a pass the gate fails, and an unknown `partnerMode` reads as `off` with a warning.

### Personal handwriting samples test (2026-10-02, not adopted)

Franco's idea: show the partner, besides the printed reference, 3–5 of his own drill-page
copies of the target, so it judges against how *he* writes the character rather than
against print. Samples came from drill rows on sheets dated before the recall date, cells
1–10 (the model is only in cell 0). Each was validated before use: Google's top 1 is the
character and the stroke count is within 1 of the reference. 88 of the 115 characters
tested had 5 valid samples; those without had never been written on a drill page. The
same A′ prompt was used, with one paragraph saying the samples show his normal style and
are not evidence about the recall cell.

Scored on 126 cells (the 101-cell benchmark plus 25 history cells Franco labelled), with
the stroke gate applied as shipped:

| | A′ (print reference) | A″ (+ his samples) |
|---|---|---|
| His 30 rejected history cells: correct ones accepted | 7 / 20 | 14 / 20 |
| His 30 rejected history cells: wrong ones accepted | 2 / 10 | 3 / 10 |
| Benchmark Google passes: correct ones rejected | 2 / 53 | 6 / 53 |
| Decoys accepted | 1 / 20 | 0 / 20 |
| Pipeline errors, partner `off` | 5 | 5 |
| Pipeline errors, partner `ambiguous` | 4 | 4 |
| Pipeline errors, partner `always` | 16 | 13 |

The samples did what they were meant to on his history (twice as many correct characters
accepted) but made the partner invent errors elsewhere ("会: 云 missing its two horizontal
strokes", with both clearly there). Probably his drill copies, written with the model in
view, are neater than his writing from memory, and the model reads that gap as an error.
The differences are within grok-4.6's run-to-run noise: one prompt gave 2 and 5 false
rejections on two runs. Partner stays `off`. The validated sample library is the useful
by-product; see the refinement under the future option below.

## Review records and revisions

`reviews.json` stays append-only. `Review` gains:

```ts
evidence: 'transcription' | 'ink' | 'recognition' | 'confusion'; // first two: legacy
sources?: string[];      // recognisers that produced the verdict, e.g. ['google', 'go:grok-4.6']
read?: string;           // what was written, as agreed or as read by the tier used
asked?: string;          // confusion only: the character the cell was asking for
degraded?: boolean;
revision?: number;       // absent = 0
```

**Revisions are how anything is corrected.** Re-grading a date appends a new full set of
that date's verdicts with `revision` one higher. Replay and `suspectedMisreads` use only
the highest revision of each date, so history is kept and the schedule follows the
correction. Schedules and the relearn list are already replayed rather than stored, so
nothing else needs updating, except that relearn selection's lapse dates (`lapseDates`)
must also read only the latest revisions.

`gradeSession` idempotence becomes: skip a date if its latest revision exists and is not
degraded. The nightly run then re-grades any degraded date in the catch-up window, using
the cloud copy as today. Once both recognisers answer, the degraded flag clears.

`suspectedMisreads` ignores `confusion` records.

## Correcting the past

`xiehanzi regrade --from=2026-08-24 --to=2026-09-30 [--dry-run]`:

- Reads each date's note from the backup (`backupDir`), else from the cloud.
- Grades with the new pass rule, **without** the confusion rule, and appends one new
  revision per date.
- `--dry-run` prints every pass↔fail change per date, and what each change does to the
  next due dates. Franco reviews that output **before** the real run and the state commit.
- Expect a short review backlog: about 40 false passes become fails, and the daily recall
  cap spreads them over one to two weeks.

## Load and reliability

- Cells are graded one at a time, so a night is ~15 Google calls (instant) and ~10 grok
  calls of about 11 s each. Network-bound, negligible CPU, nothing local to load.
- No outage alarms. The summary line records the tier used per date, so a long run of
  degraded grading is visible in the job log without paging anyone.

## Modules

| Module | Role |
|---|---|
| `src/deliver/note/strokes.ts` | parse `TOTALPATH` into page-mm strokes (new) |
| `src/recall/cells.ts` | strokes and image crop per graded cell (new) |
| `src/recall/recognise/{google,go,reference}.ts` | recogniser implementations and the printed reference (new) |
| `src/recall/assess.ts` | runs the recognisers per cell; the device reading lives here |
| `src/recall/verdict.ts` | tiers, confusion rule, per-day merge; pure (new) |
| `src/recall/grade.ts` | geometry stays; transcription and ink verdicts move out |
| `src/recall/session.ts` | wiring, revision-aware idempotence, degraded re-grade |
| `src/recall/schedule.ts` | `Review` fields; replay latest revision only |
| `src/cli.ts` | `regrade` command; summary shows tiers |
| `config/recognition.json` | partner model, timeouts (new) |

## Testing

- `strokes.ts` against a committed fixture note page, checking stroke counts and
  coordinates against the ink bitmap.
- `verdict.ts` table tests: every tier, the 待/持 top-3 trap, confusion eligibility
  (radicals excluded), same-day fail-wins merge, and no confusion verdicts before
  2026-10-01.
- Replay with revisions: a later revision replaces an earlier one; mixed legacy records.
- Recognisers with mocked HTTP: timeouts, malformed JSON, multi-character candidates; for
  the partner, both images in order for every API shape, and each verdict's reading.
- A committed evaluation set: 126 labelled cells as strokes, PNGs and labels — the 101-cell benchmark plus the 25 history cells the vision partner had rejected, labelled by Franco on 2026-10-01 (20 of those 30 were correct).
  `npm run eval:recognition` re-scores any recogniser over the network, so a future model
  (a Go release, a vision-capable Jev) can be judged on the same cells before swapping.

## Risks

- **The Google endpoint is undocumented** and could change or vanish. Grading degrades to
  tier 3 automatically, and the evaluation set shows how much worse that is.
- **OpenCode Go terms and caps.** Usage is tiny, but a model can leave Go. The partner is a
  config value.
- **The stroke format is reverse-engineered.** A firmware change could move index 53.
  Defensive parsing makes that a degraded night, not wrong verdicts. The fixture test
  catches it at the next deploy.
- **Small benchmark.** 3 against 6 is a difference of a few cells. Watch the first weeks'
  degraded counts and misread flags.

## Future option — stroke matching against the reference (not built)

Recorded so it is not rediscovered. Raised 2026-10-01 as "option D" while refining the
partner prompt.

The strictness check could be done without any model: compare the written strokes
directly with the target's reference strokes. `hanzi-writer-data`, already a dependency,
holds every character's stroke outlines and medians in a 1024-unit box.

- Normalise the cell's strokes to the same box.
- Match each reference stroke to one written stroke by position, direction and shape
  (median distance, Fréchet distance), **ignoring the order they were written in**: stroke
  order is never a grading input.
- Fail the cell when reference strokes go unmatched, written strokes are left over, or a
  component's strokes land in the wrong place.

It catches exactly what Google lets through: 禾 for 木 is one extra stroke, 道 without its
top is three missing ones. It is deterministic, free, instant, local, and cannot be biased
by being shown the answer.

The costs: about an afternoon to prototype, and a real risk of false fails on fluent or
cursive handwriting, where strokes are joined. It would need tolerance tuning against the
labelled evaluation set (`eval/recognition/`), and possibly a learner-handwriting leniency
factor. Evaluate it with `npm run eval:recognition` before it replaces or joins the vision
partner.

### Refinement: match against Franco's own strokes (personal templates)

Raised 2026-10-02. The most promising version of this option compares the recall attempt
not with the font's strokes but with his own drill copies of the same character. That
removes the main risk above, because his style is the template: the same hand writes both.

- **Template source.** The drill pages already hold, for every recall character, up to
  ten freehand copies per sheet as pen strokes. Rows and cells are found from the printed
  grid in each page's LAYER1 (dark- and light-grey border lines; 9 rows of 11 cells, the
  model in cell 0). They are mapped to characters in manifest order across drill pages.
  Strokes belong to the cell their centroid falls in.
- **Validation.** A copy becomes a template only if Google reads it as the character and
  its stroke count is within 1 of the reference. On the 2026-10-02 test this gave 5
  templates for 88 of 115 characters. The rest were never written on a drill page: the
  2026-08-20 and 08-21 sheets were not written on, and on 08-25 only the first drill page
  was.
- **Matching.** Same as above (order-independent stroke assignment, position, direction,
  shape), but against several templates. Pass if the attempt matches any template within
  tolerance; fall back to the font reference when a character has no templates.
- **What it would catch.** Component errors that keep the stroke count, which the gate
  misses (觉, 论, 样 written with 禾). It does not need a model, a network or money.
- **Caveat.** A habit he also has when copying (里 with the vertical through the top) would
  become a template. Validation's stroke-count check removes that one; a habit that keeps
  the stroke count would not be caught.

A throwaway prototype of the template extraction was built to produce the numbers above;
it is not part of the shipped code.
