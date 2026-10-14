# xiehanzi — Design Spec

**Date:** 2026-08-19
**Status:** implemented.

> **As built:** the trace fade described below was later removed. The model glyph sits in
> the first cell only and the rest of the row is blank (`src/render/layout.ts`): the fade ate
> space, and its faintest steps did not survive e-ink rendering. Passages about the fade are
> marked *(later removed)*.

## Context

Franco's Chinese study plan calls for a daily handwriting practice sheet delivered to the
Supernote every morning. The practice already happens by hand — the Supernote has notes
under `/Note/中文/写汉字/` — but nothing decides *which* characters to drill, and nothing
tracks what has been covered.

### Governing insight

**Anki measures recognition. This project trains production.** The majority of the
HSK 1–3 deck is mature, yet most of those characters cannot be written from memory. The two
therefore keep **separate state**: writing ability is never inferred from Anki intervals,
and the skip list is hardcoded rather than derived from card maturity.

## Scope

**v1:** character drills only, both selection modes, delivery to the device, and the
capture path.

**Deferred:** image-description sheets (AI-generated line art when built), sentence copying,
and whole-word writing blocks alongside the per-character rows.

## Decisions

| Area | Decision |
|---|---|
| Stack | TypeScript (Node 22) + Playwright → PDF (later a native `.note`; see *Delivery*) |
| Page | 162.6 × 216.7 mm (Manta, 1920×2560 @ 299 DPI), 8 mm margins |
| Unit | Individual hanzi, decomposed from vocab words |
| Cell | Default 10 mm, 14 reps/row — config-driven |
| Fade | *(later removed; model glyph in cell 1 only)* solid → 55% → 25% → 12% grey over first 4 cells, then blank |
| Grid | 米字格 default, 田字格 via config |
| Stroke order | 5 mm 笔顺 filmstrip, newest stroke dark |
| Selection | Both linear catch-up and double-down review |
| Linear order | HSK 3.0 band → frequency within band |
| Skip list | Hardcoded, editable |
| Anki | AnkiConnect HTTP only. Never writes the collection file. |
| Runtime | Developed on a laptop, run as a scheduled job on an always-on machine |

## Verified environment (2026-08-19)

Confirmed against the running AnkiConnect instance. These were open questions during
planning; they are now closed.

**Decks** — three, one per HSK 3.0 stage:

| Role | Deck | ~cards |
|---|---|---|
| elementary | `HSK 3.0 Vocabulary::Bands 1-3: Elementary` | 2,403 |
| intermediate | `HSK 3.0 Vocabulary::Bands 4-6: Intermediate` | 3,268 |
| advanced | `HSK 3.0 Vocabulary::Bands 7-9: Advanced` | 5,634 |

**Note type in use is `Basic+`** — *not* the `Basic - New HSK (2025) …` family. Fields:

    Hanzi · FrontSentence · Pinyin · Definition · Emoji · Translation
    HanziAudio · FrontSentenceAudio

Tagged `default` + band name (`Elementary` / `Intermediate` / `Advanced`).

These six content fields are a 1:1 match for the class-note vocab table columns
(汉字 | Pinyin | English | emoji | Example Sentence | Translation), which is what the
separate notes workflow writes into. `learn` must produce identical notes.

> **Finding worth revisiting:** the collection defines a
> `Basic - New HSK (2025) with sentences - Write` note type with **zero cards**. It came
> with the shared HSK 3.0 deck and is unused. Whether writing proficiency should eventually
> live in Anki Write cards rather than this repo's own state is an open design question —
> **out of scope for v1**, which keeps its own state as decided.

## Architecture

The layout as built (the original plan grouped a few of these differently):

```
src/
  sources/    ankiconnect.ts · vocab.ts · hsk.ts · hskwords.ts · glossary.ts
  select/     decompose.ts · linear.ts · doubledown.ts · enrich.ts
  capture/    learn.ts · backup.ts
  render/     glyph.ts · layout.ts · sheet.ts · recall.ts · document.ts · pdf.ts · bitmap.ts
  deliver/    note/ (write.ts, read.ts, strokes.ts) · supernote/ (cloud.ts, push.ts, …)
  recall/     pool · schedule · grade · verdict · session · recognise/   (later specs)
  state/      queue.ts · sheets.ts · reviews.ts
  cli.ts      generate | add | learn | push | grade | carry | …
config/       skip.json · decks.json · delivery.json · recognition.json
```

Selection and rendering must not know about each other. Everything upstream produces:

```ts
type CharacterPlan = {
  char: string;
  pinyin: string;
  meaning: string;
  strokeCount: number;
  sourceWord?: string;      // 冰激凌 for 激
  reason: 'manual' | 'new' | 'class' | 'hard' | 'linear';
};
```

### Glyph rendering — one source of truth

**The practice characters are not set in a font.** Both the practice-cell glyphs and the
filmstrip render as SVG paths from `hanzi-writer-data`, and the trace fade *(later removed)* was
fill-opacity applied to those same paths. This is what guarantees the model glyph, the faded tracing
glyphs and the stroke-order breakdown are *identical shapes* — a font plus a separate stroke
diagram cannot promise that, and any mismatch would teach the wrong stroke forms.

Provenance: `hanzi-writer-data` derives its outlines from **Make Me a Hanzi**, which extracts
them from Arphic's **AR PL UKai** — a true 楷体. So the shapes are already kai forms, which
is what handwriting practice wants. Coverage is ~9,500 characters.

Fonts are used for exactly two things:

| Purpose | Face | Licence |
|---|---|---|
| Pinyin, meanings, headers | **LXGW WenKai** (霞鹜文楷) | SIL OFL 1.1 |
| Fallback glyph for characters outside the dataset | LXGW WenKai | SIL OFL 1.1 |

LXGW WenKai is itself a kai-style face, so a fallback character sits beside dataset glyphs
without an obvious style break — though it will have **no stroke-order filmstrip and no
tracing fade** *(the fade was later removed)*, since there is no per-stroke data for it. The renderer must degrade
visibly-but-gracefully in that case (model glyph + empty cells), never silently.

> **Licence note:** AR PL UKai is distributed under the **Arphic Public License**, which
> permits redistribution with attribution. The terms carry through `hanzi-writer-data`;
> attribution is recorded in `data/README.md`.

### The HSK data, and what it revealed

The vendored charlist contains **two** taxonomies, and the standard already encodes this
project's premise:

| Section | Count | Meaning |
|---|---|---|
| 汉字表, levels 1–9 | 3,000 | characters to **recognise** |
| 手写字表, 初等/中等/高等 | 1,200 | characters to **write by hand** |

1,800 are recognition-only by design. The bands deliberately do not line up — 中等手写 draws
356 of its 400 characters from reading levels 1–3, because handwriting lags recognition — so
they are parsed as independent facts, never derived from one another.

### Selection modes

**Linear catch-up** walks the 1,200 handwriting characters first (初等 → 中等 → 高等,
frequency-ordered within each band), then continues into the recognition-only remainder.

*Position is a set of characters already done, not an index.* An index would silently point
somewhere else the moment the skip list or the extras setting reordered the sequence, and the
error would surface only as sheets that looked subtly wrong.

*Anki extras* interleave by frequency using each band's **median** rank as the boundary. Band
ceilings do not work: they overlap badly (初等 reaches rank 1972 while 中等 reaches 3650), so a
ceiling rule would drop nearly every extra into the first band. Off unless explicitly enabled.

Against the real data with the current skip list: 2,969 characters, handwriting phase 1,169.

**Double-down review** unions yesterday's new vocabulary, the most recent class's vocabulary,
and the cards with the most lapses. Quotas per source, with any shortfall redistributed so a
quiet week still fills a sheet. The selection function is pure; fetching is separate.

**There is no notes parser.** An earlier draft read class-note markdown tables out of a
notes folder. It doesn't need to: the notes workflow upstream already writes every class term
into Anki tagged `class` + the class date, normalised into fields. Verified against the real
collection: no class-tagged note is missing a date tag. Reading the notes as well
would mean a second source of truth, brittle table parsing, and a path dependency on
whichever machine runs the job. Anki is canonical; the notes are its upstream.

Two traps the real data exposed, both handled:

- The date tag alone is **not** sufficient — `chinesepod` notes use the same convention, and
  `learn` stamps today's date via `capture`. Queries require `tag:class` as well.
- `introduced:n` means "within the last n days", so a single day must be bracketed:
  `introduced:2 -introduced:1` for yesterday.

Hardest cards are found by walking `prop:lapses>=N` thresholds downward rather than calling
`cardsInfo`, which returns ~100K characters of template HTML per batch. The reported lapse
count is therefore a lower bound; the ordering is exact.

### Capture from life

`xiehanzi add 惯 父 --on=tomorrow` pins characters. Pins run **in front of** the active mode
and *displace* rather than append, so a pin cannot push the sheet over its daily count.

`xiehanzi learn 塑料 --pinyin=sùliào --meaning="plastic"`:

These semantics are **copied from** the notes workflow, which writes to the
same decks, not re-derived. Two code paths scheduling the same decks by different rules
would poison the collection quietly.

0. **Back up first — always.** `POST` to a local backup service that snapshots the
   collection before any write (`XIEHANZI_ANKI_BACKUP_URL` overrides the default URL).
   **If it fails, abort without mutating** — a hard precondition, exactly as the notes
   workflow requires. Reusing one service rather than a bespoke `exportPackage` scheme
   keeps one backup story for the whole collection. A setup with no such service sets
   `XIEHANZI_ANKI_BACKUP=off`, which skips the step with a warning. Client:
   `src/capture/backup.ts`.

1. **Look up** the term: `findNotes` with `deck:"HSK 3.0 Vocabulary" Hanzi:<term>`.

2. **Create if missing** — `addNote`, model `Basic+`, default deck
   `HSK 3.0 Vocabulary::Bands 1-3: Elementary` (Intermediate if clearly higher level),
   `options: {allowDuplicate: false, duplicateScope: "deck"}`.

3. **Bucket by queue state, and branch on that — never on existence.** This is the step
   that matters. Use `findCards` with `nid:… is:new` and `nid:… -is:new`; do **not** use
   `cardsInfo`, which returns ~100K chars of template HTML per batch. Every card must land
   in exactly one bucket — if the two lists don't sum to the full set, re-run rather than
   guess.

   | Bucket | Action | Never |
   |---|---|---|
   | **new** (`queue=0`), including cards just created in step 2 | `answerCards` ease=1 (Again) — logs a real review, moves it into the learning queue, bypasses the daily new-card limit | `setDueDate` |
   | **learning/review** (`queue≠0`) | `setDueDate(days="0")` — due today | `answerCards` |

   > **Never apply both.** `setDueDate` on a new card converts it into a review card with a
   > forced interval, bypassing learning steps. Damage signature: `type: 2, queue: 2,
   > reps: 0`. Recovery is `forgetCards` + reposition to the front of the new queue.

4. **Tag** via `addTags` (idempotent). Existing band tags (`Elementary` / `Intermediate`)
   are left untouched.

5. **Writing queue** → decompose to hanzi, drop skip-list entries, enqueue for the next sheet.

6. **`sync` to AnkiWeb — mandatory final step**, so the change reaches other devices. Report a
   sync failure; never swallow it.

7. **Report exactly what it did** — created vs. found, which bucket, which characters
   enqueued — so whatever called it can relay it truthfully rather than assume success.

### State

`state/` holds the manual queue, a per-day manifest of each sheet, and (from the recall
spec) the review log. Linear position is derived from the manifests rather than stored. The
manifest is what makes "yesterday's new vocab" derivable tomorrow. Committed to git.
Consumed queue entries are archived with a `consumedOn` stamp, never deleted — reruns stay
idempotent and nothing vanishes if a render fails.

## Delivery — decided empirically

The plan was staged so the riskiest dependency was tested last:

1. **Phase A** — write to `out/`. All development happens here.
2. **Phase B** — write into an Obsidian vault and let a sync plugin push it to the device.
   Test before committing to it.
3. **Phase C** — if B is unreliable headless, direct Supernote Cloud upload to
   `/Note/中文/写汉字/`. Unofficial API; credentials in `.env`, never committed.

### As built (2026-08-20 onward)

Phase C shipped, and the PDF did not. The sheet is a **real Supernote notebook** — a `.note`
file written by `src/deliver/note/write.ts` — so it opens and is written in natively, and
syncs back as one file. No PDF to import, no annotation sidecar, no second copy.
`--format=pdf` still produces a PDF for printing.

Two things learned the hard way, both recorded in the code:

- **`PAGESTYLE` is not a label.** The device resolves it against its own template store and
  treats what it finds as authoritative. A custom name sends it looking for a template that
  does not exist, and it **hangs on "loading" with the note unopenable**. A built-in name
  opens, but the device later *rewrites the file*, replacing the embedded background with
  its own template of that name — observed live, a page's 271 KB sheet swapped for a
  600-byte blank. There is no safe name, so the background layer is the wrong home: pages
  name a built-in style, the sheet is drawn into `LAYER1` as ordinary ink the device has no
  opinion about, and `BGLAYER` stays the blank template it claims to be.
- **Two independent parsers accepting a generated `.note` does not mean the device will.**
  They read fields the firmware also acts on. The device is the only real test.

**Delivery is idempotent, so a retry is always safe.** A note is byte-reproducible from the
sheet name, `generate` reproduces an existing sheet rather than planning a new one, and
`src/deliver/supernote/push.ts` compares md5 checksums and does nothing when the file is
already there. Replacing a remote file is a compare-and-swap against the checksum last
pulled, keeps a copy of the old one first, and is refused outright if the notebook has been
written on since.

**One sheet at a time** (added 2026-10-04). Before generating, `xiehanzi carry` (in
`src/cli.ts`) grades the most recent earlier sheet. If it came back with no ink, or never
reached the cloud, no new sheet is made: the unwritten one is renamed to today — on the
cloud, locally and in the manifest — so the device never holds two blank sheets under
different dates. Its recall rows are simply overdue. The manifest records `carriedFrom`,
and grading tries the old names too, in case the device held unsynced ink under the old
name when the rename happened. A sheet without recall rows never blocks, and a failed check
falls back to generating as usual.

## Scheduling

A scheduled job on an always-on machine runs `bin/morning.sh` early each morning: compile,
grade anything newly synced, carry or generate, push. It exits non-zero on any failure, so
the scheduler withholds its heartbeat and a watchdog alarms if the sheet silently stops
arriving. Deterministic work — a
script, never an LLM call.

## Testing

TDD throughout, Vitest.

- **Unit** — decomposition (multi-char words, punctuation, non-HSK characters), skip-list
  filtering, linear ordering and cursor advance, double-down union and dedup, queue date
  parsing and displacement precedence.
- **Capture** — `learn` against a mocked AnkiConnect: both branches, no duplicate note on
  re-run, resulting due date is today or tomorrow. This is the only destructive module, so
  it gets the most test pressure.
- **Contract** — AnkiConnect client against recorded fixtures, so tests run without Anki.
- **Visual** — fixed `CharacterPlan[]` fixture → PDF; assert exact mm dimensions; screenshot
  the HTML for review.

## Verification

1. `--mode=linear` → sheet in `out/`; page exactly 162.6 × 216.7 mm; 14 cells inside
   147 mm; fade blank by cell 5 *(fade later removed)*; filmstrip's last thumbnail matches the model glyph.
2. `--mode=doubledown` with Anki reachable; characters trace to recent class notes and
   high-lapse cards.
3. `add` then generate — pinned characters first, marked consumed after.
4. `learn` against a **test deck first**; verify card exists, review logged today at *again*,
   due today/tomorrow; re-run creates no duplicate.
5. Same date twice — identical output, cursor does not double-advance, consumed entries do
   not reappear.
6. Capture a term from another device, through whatever runs `learn` remotely. It should
   reach Anki and the next sheet with no terminal.
7. Write a page on the Manta. The only test that matters.

## Risks

- **HSK list provenance** — vendor and licence-check a source (`elkmovie/hsk30` candidate).
  Frequency must be joined from a corpus list; if coverage is poor, fall back to
  band→stroke-count ordering. Sources are recorded in `data/README.md`.
- **Band→frequency ordering** surfaces high-stroke characters early within a band. Config
  knob; revisit after a week of real sheets.
- **Supernote Cloud API is unofficial** — why Phase B was to be tested first.
- **`learn` mutates the collection** — the only destructive operation. Mitigations, in
  order of strength: a **mandatory pre-mutation backup via a local backup service that
  aborts the run if it fails** (opt-out only by `XIEHANZI_ANKI_BACKUP=off`), queue-state bucketing that never applies `setDueDate` to a
  new card, AnkiConnect only (never the collection file), `--dry-run`, first runs against a
  test deck, plus Anki's own automatic backups and a separate nightly backup.
- **Divergence from the notes workflow is a live risk** — both write the same decks.
  Its rules are duplicated here by necessity; cross-check whenever either changes.
- **Whether writing proficiency should eventually live in Anki's unused `Write` note type**
  rather than this repo's state remains open.
