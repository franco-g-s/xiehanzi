#!/usr/bin/env node
/**
 * xiehanzi CLI.
 *
 * Kept thin and dependency-injected: `run` takes everything it touches, so the commands
 * are testable without Anki, the network or the real filesystem.
 *
 * Every command supports --json, because the primary caller is an agent that has to
 * report what happened truthfully rather than assume it worked.
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';

import { createAnkiClient, type AnkiClient } from './sources/ankiconnect.js';
import { loadDictionary, type Dictionary } from './dict/cedict.js';
import { loadHsk, type HskCatalogue } from './sources/hsk.js';
import { loadHskWords } from './sources/hskwords.js';
import { createAnkiVocabSource, type VocabSource } from './sources/vocab.js';
import {
  loadGlossary, fetchGlossary, serialiseGlossary, countChanged, parseGlossary,
  type Glossary, type GlossaryFile,
} from './sources/glossary.js';
import { AnkiConnectError } from './sources/ankiconnect.js';
import { createQueueStore, resolveDate, type QueueStore } from './state/queue.js';
import { createSheetStore, type SheetStore, type RecallRow, type RecallGeometry } from './state/sheets.js';
import { createReviewStore, type ReviewStore } from './state/reviews.js';
import { gradeSession, type GradeDeps, type GradeSummary } from './recall/session.js';
import type { Recognisers } from './recall/recognise/http.js';
import type { PartnerMode } from './recall/verdict.js';
import { buildRecognisers, loadGoKey, loadRecognitionConfig } from './recall/recognise/config.js';
import { introducedDates } from './recall/pool.js';
import { addDays, replay, type Review } from './recall/schedule.js';
import { decompose } from './select/decompose.js';
import { enrich, createExampleIndex, type ExampleIndex } from './select/enrich.js';
import { learn } from './capture/learn.js';
import { backupFromEnv } from './capture/backup.js';
import { planSheet, planRecall, handwritingChars, DEFAULT_COUNT, DEFAULT_DOUBLE_DOWN } from './generate.js';
import type { RecallSelection } from './generate.js';
import { createCloudClient, type SupernoteCloud } from './deliver/supernote/cloud.js';
import { pushNote } from './deliver/supernote/push.js';
import { backupDrive } from './deliver/supernote/backup.js';
import { VerificationRequiredError } from './deliver/supernote/cloud.js';
import { loadSession, saveSession, clearSession } from './deliver/supernote/session.js';
import { DEFAULT_SHEET_CONFIG } from './render/layout.js';
import { recallGeometry, buildCues, DEFAULT_RECALL_CONFIG, type RecallPlan } from './render/recall.js';
import { renderPracticeSheet } from './render/sheet.js';
import { renderPdf } from './render/pdf.js';
import { renderPageBitmaps } from './render/bitmap.js';
import { writeNote } from './deliver/note/write.js';

export type CliDeps = {
  queue: QueueStore;
  sheets: SheetStore;
  reviews: ReviewStore;
  dictionary: () => Dictionary;
  examples: () => ExampleIndex;
  catalogue: () => HskCatalogue;
  /** Definitions from your own Anki deck, from the committed extract. Never fails; see glossary.ts. */
  glossary: () => Glossary;
  /** Where `xiehanzi glossary` writes that extract, and where `glossary()` reads it from. */
  glossaryPath: string;
  /** The Anki deck `xiehanzi glossary` reads. */
  glossaryDeck: string;
  anki: () => AnkiClient;
  vocab: () => VocabSource | undefined;
  backup: () => Promise<unknown>;
  /** Injectable so tests can plan a sheet without launching a browser. */
  writePdf: (html: string, path: string) => Promise<void>;
  /** Writes a real Supernote notebook, so the sheet can be written on natively. */
  writeNoteFile: (html: string, path: string, styleStem: string) => Promise<void>;
  outDir: string;
  /** Folder on Supernote Cloud that the device syncs down. */
  remoteDir: string;
  /** Where a full mirror of the Supernote drive is kept. */
  backupDir: string;
  /** Built lazily — only `push` and `login` need credentials. */
  cloud: () => SupernoteCloud;
  sessionPath: string;
  /** Built lazily: only grading needs recognisers, and building one reads the Go key. */
  recognisers: () => Recognisers;
  /** First date the confusion rule applies; from config/recognition.json. */
  confusionFrom: string;
  /** When the partner is asked, and the stroke gate's limit; from config/recognition.json. */
  partnerMode: PartnerMode;
  maxStrokeDelta: number;
  /** Reads one line from the operator. Injectable so tests never block on stdin. */
  prompt: (question: string) => Promise<string>;
  now: () => Date;
  skip: string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

const USAGE = `xiehanzi — Chinese handwriting practice sheets

  xiehanzi add <chars|word...> [--on=today|tomorrow|YYYY-MM-DD] [--note=TEXT]
      Pin characters to a practice sheet. Words are split into their hanzi.

  xiehanzi learn <term> --pinyin=P --meaning=M [--sentence=S] [--translation=T]
                        [--emoji=E] [--deck=D] [--dry-run]
      Capture a term: upsert the Anki card, reschedule it for today, and queue
      its characters for the next sheet.

  xiehanzi login [--forget]
      Sign in to Supernote Cloud. If the account asks for a verification
      code, it is emailed to you and typed in here. The session token is
      saved so scheduled pushes work unattended; the password is not.

  xiehanzi push [--date=YYYY-MM-DD] [--file=PATH] [--replace] [--dry-run]
      Upload a sheet to Supernote Cloud; the device syncs it down. Needs
      SUPERNOTE_EMAIL and SUPERNOTE_PASSWORD in .env. A remote file that
      differs is refused, not overwritten — it has probably been written on.

  xiehanzi backup [--dest=DIR] [--dry-run]
      Mirror the whole Supernote drive to disk. Downloads only what has
      changed, verifies every checksum, and never deletes — a file that
      vanishes from the cloud is kept and reported.

  xiehanzi grade [--date=YYYY-MM-DD] [--dry-run]
      Pull the day's written-on sheet back from Supernote Cloud and grade
      its recall rows into the review log. Grading a date twice is a no-op.
      A sheet with no ink on it records nothing, rather than marking every
      row wrong.

  xiehanzi carry [--date=YYYY-MM-DD] [--dry-run]
      Decide whether today gets a new sheet. If the most recent earlier sheet
      came back with no ink (or never reached the cloud), it is renamed to
      today — cloud, local copy and manifest — instead of a second blank one
      being made. Prints "decision: carried" or "decision: generate" last.

  xiehanzi regrade --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--dry-run]
      Re-grade past sheets with the current recognisers, from the backup where
      present. Records a new revision only where a verdict changes; --dry-run
      lists every pass/fail change, each changed character's next due date,
      and the effect on today's due count. --to defaults to yesterday and must
      be before today. Refuses to run unless Google is configured, and the
      partner too unless partnerMode is off; exits 1 if any date errored or
      ended degraded.

  xiehanzi glossary [--dry-run]
      Refresh data/anki-glossary.json from Anki — the definitions you
      actually study, which the sheet prefers over CC-CEDICT's first
      substantive sense. The file is committed on purpose: the scheduled
      job runs on a machine with no Anki, and the same date must render to
      the same bytes on both. Needs Anki running with AnkiConnect.

  xiehanzi lookup <term>
      Look the term up in CC-CEDICT. Read-only; useful for checking pinyin
      and meaning before calling learn.

  xiehanzi queue
      Show the characters waiting for a sheet.

  xiehanzi generate [--date=YYYY-MM-DD] [--count=N] [--review=N]
                    [--format=note|pdf|both] [--out=DIR] [--force] [--dry-run]
      Build the day's practice sheet. Manual pins first, then
      review, then HSK catch-up. Re-running a date reproduces the same
      sheet unless --force is given. Default format is a real .note you
      write in directly on the device — no PDF import, no .mark.

Options:
  --json     machine-readable output
  --help     this message
`;

function isoToday(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Splits an argument into hanzi, so `add 冰激凌` and `add 冰 激 凌` behave the same. */
function charsFrom(args: readonly string[]) {
  return decompose(args);
}

async function cmdAdd(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { on: { type: 'string' }, note: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length === 0) {
    deps.stderr('Give at least one character or word to add.');
    return 1;
  }

  let date: string | null;
  try {
    date = resolveDate(values.on, deps.now());
  } catch (e) {
    deps.stderr((e as Error).message);
    return 1;
  }

  // Deliberately unfiltered: the skip list exists to keep linear catch-up from wasting
  // rows, not to veto a character you explicitly asked for.
  const chars = charsFrom(positionals);
  if (chars.length === 0) {
    deps.stderr('Nothing to add — no hanzi in that input.');
    return 1;
  }
  const easy = chars.filter((c) => deps.skip.includes(c.char)).map((c) => c.char);

  const added = deps.queue.add(chars, {
    date,
    ...(values.note === undefined ? {} : { note: values.note }),
  });

  if (json) {
    deps.stdout(JSON.stringify({ added, date, skipped: chars.length - added.length }, null, 2));
    return 0;
  }

  if (added.length === 0) {
    deps.stdout(`Nothing new — already queued: ${chars.map((c) => c.char).join(' ')}`);
    return 0;
  }

  const when = date === null ? 'the next sheet' : date;
  deps.stdout(`Queued for ${when}: ${added.map((e) => e.char).join(' ')}`);
  if (easy.length > 0) {
    deps.stdout(`  · note: ${easy.join(' ')} ${easy.length === 1 ? 'is' : 'are'} on the skip list, queued anyway because you asked.`);
  }
  if (added.length < chars.length) {
    const dupes = chars.filter((c) => !added.some((a) => a.char === c.char));
    deps.stdout(`Already queued: ${dupes.map((c) => c.char).join(' ')}`);
  }
  return 0;
}

/**
 * Recall needs the same dictionary and example-index lookups a drill row gets — `enrich`
 * already does exactly that. `reason` is drill-specific bookkeeping the recall renderers
 * never read, so a placeholder is fine here rather than teaching `enrich` a second shape.
 */
function enrichRecall(
  selections: readonly RecallSelection[],
  options: { dictionary: Dictionary; examples: ExampleIndex; glossary: Glossary },
): RecallPlan[] {
  return enrich(
    selections.map((s) => ({ char: s.char, reason: 'new' as const })),
    // Every answer on the sheet, so a row's example word can be chosen to name none of the
    // others — see `EnrichOptions.avoid`. Passed here and NOT on the drill call above: a
    // drill row prints its own model character, so overlap there gives nothing away, and
    // narrowing the choice would only make the examples worse.
    { ...options, avoid: new Set(selections.map((s) => s.char)) },
  );
}

/**
 * The physical page of the delivered document each recall page occupies.
 *
 * The sheet interleaves each recall page with the answers page that answers it — recall 0,
 * answers 0, recall 1, answers 1 — so the nth recall page is the 2nth page of the .note.
 * `RecallRow.page` is a page index into that document, which is what `gradeSession` reads
 * it as (it indexes `note.pages` with it directly); it has always meant that, and the
 * interleave is why the arithmetic is no longer the identity. Get this wrong and the
 * evening job scores an answers page — no ink on it anywhere — as a whole page of rows
 * never attempted, while the real attempts on the recall page after it are never graded.
 *
 * Manifests written before the interleave recorded 0 and 1, which were the physical indices
 * of the recall pages on the sheets actually printed then. Those sheets are on the device
 * and are still graded against that record, so nothing rewrites them.
 */
const documentPageOf = (recallPageIndex: number): number => recallPageIndex * 2;

/**
 * Which page order the sheet behind a manifest was printed in, read back off the row
 * indices it recorded.
 *
 * Interleaved recall pages land on document pages 0, 2, 4…; the older stacked order put
 * them on 0, 1, 2…. A manifest is the only record of how its own sheet was laid out, and
 * that sheet is on the device — so a reprint has to match it rather than adopt today's
 * order, exactly as it reuses the stored geometry rather than recomputing one.
 *
 * A single-page recall section reads as interleaved, and is: with one recall page the two
 * orders produce the identical document.
 */
function pageOrderOf(rows: readonly RecallRow[]): 'interleaved' | 'stacked' {
  const pages = [...new Set(rows.map((r) => r.page))].sort((a, b) => a - b);
  return pages.every((page, i) => page === documentPageOf(i)) ? 'interleaved' : 'stacked';
}

/**
 * Where each recall item lands on the page, in the same terms `recallGeometry` and the
 * grader use: 0-indexed page and row. Saved onto the manifest so grading a written page
 * later can map ink straight back to the character it was meant to answer.
 */
function buildRecallRows(plans: readonly RecallPlan[], geometry: { rowsPerPage: number }): RecallRow[] {
  // Same set `renderRecallPages` builds from `plans` internally — every answer on the
  // sheet, not just each row's own — so the cue stored in the manifest is byte-for-byte
  // the cue that ends up printed, rather than a two-argument call that only blanks the
  // row's own character and leaks a different row's answer whenever example words overlap.
  const sheetAnswers = new Set(plans.map((p) => p.char));
  const cues = buildCues(plans, DEFAULT_RECALL_CONFIG.cueStyle, sheetAnswers);
  return plans.map((p, i) => ({
    char: p.char,
    cue: cues[i]!,
    page: documentPageOf(Math.floor(i / geometry.rowsPerPage)),
    row: i % geometry.rowsPerPage,
  }));
}

async function cmdGenerate(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      date: { type: 'string' },
      count: { type: 'string' },
      review: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  const format = values.format ?? 'note';
  if (!['note', 'pdf', 'both'].includes(format)) {
    deps.stderr(`--format must be note, pdf or both, not "${format}".`);
    return 1;
  }
  const dryRun = values['dry-run'] === true;
  const count = values.count === undefined ? DEFAULT_COUNT : Number(values.count);
  const review = values.review === undefined ? DEFAULT_DOUBLE_DOWN : Number(values.review);
  if (!Number.isInteger(count) || count < 1) {
    deps.stderr(`--count must be a positive whole number, not "${values.count}".`);
    return 1;
  }
  if (!Number.isInteger(review) || review < 0) {
    deps.stderr(`--review must be zero or more, not "${values.review}".`);
    return 1;
  }

  let date: string | null;
  try {
    date = values.date === undefined ? null : resolveDate(values.date, deps.now());
  } catch (e) {
    deps.stderr((e as Error).message);
    return 1;
  }

  // Captured BEFORE planSheet runs, because planSheet's own saveSheet call (a wholesale
  // replace of the manifest) is what erases recall/recallGeometry in the first place —
  // reading getSheet() after that call has already happened is too late to know what the
  // manifest held when the page was actually printed. Same date math planSheet uses
  // (`options.date ?? isoDate(now())` in generate.ts): `date` here is null exactly when
  // no --date was given, matching planSheet's own default.
  const targetDate = date ?? isoToday(deps.now());
  const priorSheet = deps.sheets.getSheet(targetDate);

  const generateDeps = {
    catalogue: deps.catalogue(),
    queue: deps.queue,
    sheets: deps.sheets,
    reviews: deps.reviews,
    ...(deps.vocab() === undefined ? {} : { vocab: deps.vocab()! }),
    skip: deps.skip,
    now: deps.now,
  };

  const plan = await planSheet(generateDeps, {
    ...(date === null ? {} : { date }),
    count,
    doubleDownCount: review,
    ...(values.force === true ? { force: true } : {}),
  });

  const plans = enrich(
    plan.characters.map((c) => ({
      char: c.char,
      reason: c.reason,
      ...(c.sourceWord === undefined ? {} : { sourceWord: c.sourceWord }),
    })),
    { dictionary: deps.dictionary(), examples: deps.examples(), glossary: deps.glossary() },
  );

  // Recall's capacity is derived from the same page geometry the renderer will use, so
  // the number of rows planned and the number of rows that actually fit never disagree.
  const geometry = recallGeometry(DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);

  // planSheet's drill half is idempotent for an existing date: getSheet(date) short-
  // circuits before anything is recomputed — UNLESS --force is given, in which case it
  // recomputes AND calls saveSheet, a wholesale replace that drops recall/recallGeometry
  // from the manifest. planRecall has no idempotence guard of its own — it re-derives the
  // due set from whatever is in the review log RIGHT NOW, every time it is called. So this
  // guard cannot ask the CURRENT manifest what it thinks — by the time planSheet has run,
  // the current manifest may already have had its recall erased out from under it. It has
  // to be driven by `priorSheet`, captured before planSheet touched anything, which is the
  // only true record of what the delivered page actually carried:
  //
  //   - priorSheet had recall rows       → reuse them verbatim (never re-derive: a review
  //     appended between two `generate` calls for the same date must not silently change
  //     what the manifest says was asked, even though the device already holds a sheet
  //     printed with the original set — that would corrupt history at best, and at worst
  //     produce a manifest naming a DIFFERENT set of characters than the ones actually on
  //     the page, so a later `grade` maps ink onto rows that were never printed there).
  //   - priorSheet existed but had NO recall → stay empty. The delivered page had no
  //     recall section (nothing was due when it was first generated), so a later re-run
  //     finding items due now must not retroactively invent rows for a page that was never
  //     printed with them — grading would then map recall geometry onto what is actually a
  //     drill page and read drill ink as recall answers.
  //   - no priorSheet at all → genuine first generation for this date; compute fresh.
  let recallSelections: RecallSelection[];
  let recallPlans: RecallPlan[];
  let recallRows: RecallRow[];
  let recallGeometryForManifest: RecallGeometry | undefined;
  let recallPageOrder: 'interleaved' | 'stacked' = 'interleaved';

  if (priorSheet !== null && priorSheet.recall !== undefined && priorSheet.recallGeometry !== undefined) {
    const reusableRecall = priorSheet.recall;
    recallSelections = reusableRecall.map((r) => ({ char: r.char, due: plan.date, lapses: 0 }));
    // The dictionary/example lookups are re-run for pinyin and meaning (needed to render
    // the solutions page), but each plan's `cue` is pinned to what the manifest already
    // recorded — see `RecallPlan.cue` — so the printed page can never drift from it even
    // if the underlying data changed since the sheet was first generated.
    recallPlans = enrichRecall(recallSelections, {
      dictionary: deps.dictionary(),
      examples: deps.examples(),
      glossary: deps.glossary(),
    }).map((p, i) => ({ ...p, cue: reusableRecall[i]!.cue }));
    recallRows = reusableRecall;
    recallGeometryForManifest = priorSheet.recallGeometry;
    // Same reasoning as the stored geometry on the line above: the manifest describes a
    // page that exists, and grading maps ink onto the manifest.
    recallPageOrder = pageOrderOf(reusableRecall);
  } else if (priorSheet !== null) {
    recallSelections = [];
    recallPlans = [];
    recallRows = [];
    recallGeometryForManifest = undefined;
  } else {
    const recallCapacity = geometry.rowsPerPage * DEFAULT_RECALL_CONFIG.pages;
    recallSelections = await planRecall(generateDeps, { date: plan.date, capacity: recallCapacity });
    recallPlans = enrichRecall(recallSelections, {
      dictionary: deps.dictionary(),
      examples: deps.examples(),
      glossary: deps.glossary(),
    });
    recallRows = buildRecallRows(recallPlans, geometry);
    recallGeometryForManifest = geometry;
  }

  // The manifest carries both the characters asked for and where on the page they were
  // asked — grading a written page later has to map ink back to a row without re-deriving
  // layout that may have since changed.
  deps.sheets.saveSheet({
    date: plan.date,
    characters: plan.characters,
    // recallGeometryForManifest is only ever undefined in the branch that also leaves
    // recallRows empty (priorSheet existed with no recall) — the non-null assertion holds
    // because the two are set together in every other branch above.
    ...(recallRows.length === 0 ? {} : { recall: recallRows, recallGeometry: recallGeometryForManifest! }),
  });

  // Named for the device: date first so the folder sorts chronologically.
  const stem = `${plan.date} 写汉字`;
  const dir = values.out ?? deps.outDir;
  // ONE document — see render/document.ts. Three concatenated documents merged their
  // stylesheets and broke the drill pages' header.
  //
  // The geometry passed here is the geometry saved on the manifest, never the freshly
  // computed default: on the reuse path they are allowed to differ (the manifest may
  // record a layout printed under an older config), and grading maps ink onto whatever
  // the manifest says. A reprint drawn with today's geometry against yesterday's manifest
  // would score ink against the wrong rows.
  const html = renderPracticeSheet({
    plans,
    recallPlans,
    meta: { date: plan.date, mode: 'linear + review' },
    config: DEFAULT_SHEET_CONFIG,
    recall: DEFAULT_RECALL_CONFIG,
    geometry: recallGeometryForManifest ?? geometry,
    recallPageOrder,
  });

  const written: string[] = [];
  if (!dryRun) {
    if (format === 'note' || format === 'both') {
      const notePath = join(dir, `${stem}.note`);
      await deps.writeNoteFile(html, notePath, stem);
      written.push(notePath);
    }
    if (format === 'pdf' || format === 'both') {
      const pdfPath = join(dir, `${stem}.pdf`);
      await deps.writePdf(html, pdfPath);
      written.push(pdfPath);
    }
  }

  if (json) {
    // MINOR: `generate` is the only non-page path by which the day's recall answers could
    // reach a human before the sheet is written on — the count is all a caller needs to
    // confirm recall ran, and printing the characters themselves would defeat the whole
    // point of a system designed to grade without Franco ever having to look at the answer.
    deps.stdout(
      JSON.stringify({ ...plan, recallCount: recallSelections.length, files: written, format, dryRun }, null, 2),
    );
    return 0;
  }

  if (dryRun) deps.stdout('DRY RUN — no file was written.');
  const verb = plan.reused ? 'Reused' : dryRun ? 'Would build' : 'Built';
  deps.stdout(`${verb} ${plan.date} — ${plan.characters.length} characters`);

  const parts = Object.entries(plan.counts)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`);
  if (parts.length > 0) deps.stdout(`  · ${parts.join(', ')}`);
  deps.stdout(`  · ${plan.characters.map((c) => c.char).join(' ')}`);
  if (recallSelections.length > 0) {
    deps.stdout(`  · recall: ${recallSelections.length}`);
  }
  for (const f of written) deps.stdout(`  · ${f}`);
  if (plan.reused) deps.stdout('  · already generated for this date; --force to rebuild.');
  for (const w of plan.warnings) deps.stdout(`  ⚠ ${w}`);

  return 0;
}

/**
 * Refreshes the committed glossary from Anki.
 *
 * Deliberately a separate command rather than something `generate` does: the file is what
 * makes a sheet reproducible on a machine that has no Anki, and a silent refresh mid-run
 * would mean two machines could render the same date differently — which is
 * exactly the difference `push` uses to tell an unchanged sheet from one written on.
 */
async function cmdGlossary(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const dryRun = values['dry-run'] === true;

  // What is on disk now, so the report can say what actually moved rather than just how
  // many entries there are. A missing or unreadable file simply means "everything is new".
  let before: GlossaryFile['entries'] = {};
  try {
    before = (JSON.parse(readFileSync(deps.glossaryPath, 'utf8')) as GlossaryFile).entries ?? {};
  } catch {
    before = {};
  }

  let file: GlossaryFile;
  try {
    file = await fetchGlossary(deps.anki(), deps.glossaryDeck);
  } catch (e) {
    if (!(e instanceof AnkiConnectError)) throw e;
    // The existing file is left exactly as it is: a refresh that cannot read Anki must
    // never replace good definitions with nothing.
    deps.stderr(`${(e as Error).message}\nThe committed glossary at ${deps.glossaryPath} was left untouched.`);
    return 1;
  }

  const entries = Object.keys(file.entries).length;
  const changed = countChanged(before, file.entries);

  if (!dryRun) {
    const text = serialiseGlossary(file);
    // Parsed back before it is trusted: a file this command writes is the file every later
    // `generate` reads, and `loadGlossary` degrades silently rather than complaining.
    parseGlossary(text);
    mkdirSync(dirname(deps.glossaryPath), { recursive: true });
    writeFileSync(deps.glossaryPath, text, 'utf8');
  }

  if (json) {
    deps.stdout(JSON.stringify({ deck: file.deck, entries, changed, path: deps.glossaryPath, dryRun }, null, 2));
    return 0;
  }

  if (dryRun) deps.stdout('DRY RUN — nothing was written.');
  const verb = dryRun ? 'Would write' : 'Wrote';
  deps.stdout(`${verb} ${entries} definitions from ${file.deck} — ${changed} changed.`);
  deps.stdout(`  ${deps.glossaryPath}`);
  return 0;
}

async function cmdLogin(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { forget: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });

  if (values.forget === true) {
    clearSession(deps.sessionPath);
    deps.stdout('Signed out; the stored session token has been deleted.');
    return 0;
  }

  const cloud = deps.cloud();
  let token: string;

  try {
    token = await cloud.login();
  } catch (e) {
    if (!(e instanceof VerificationRequiredError)) throw e;

    deps.stdout('This account needs a verification code. Sending one by email…');
    const challenge = await cloud.requestVerification(e.timestamp);
    const code = await deps.prompt('Six-character code from your email: ');
    token = await cloud.verify(challenge, code);
  }

  saveSession(deps.sessionPath, {
    token,
    account: process.env.SUPERNOTE_EMAIL ?? '',
    savedAt: deps.now().toISOString(),
  });

  if (json) {
    deps.stdout(JSON.stringify({ loggedIn: true, sessionPath: deps.sessionPath }, null, 2));
    return 0;
  }
  deps.stdout(`Signed in. Session saved to ${deps.sessionPath}`);
  return 0;
}

async function cmdBackup(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { dest: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });

  const dest = values.dest ?? deps.backupDir;
  const dryRun = values['dry-run'] === true;

  const cloud = deps.cloud();
  const session = loadSession(deps.sessionPath);
  if (session === null) {
    deps.stderr('Not signed in to Supernote Cloud. Run `xiehanzi login` first.');
    return 1;
  }
  cloud.useToken(session.token);

  const result = await backupDrive(cloud, dest, {
    ...(dryRun ? { dryRun: true } : {}),
    ...(json ? {} : { onProgress: (path, action) => {
      if (action !== 'unchanged') deps.stdout(`  ${action === 'saved' ? '+' : '!'} ${path}`);
    } }),
  });

  if (json) {
    deps.stdout(JSON.stringify({ dest, dryRun, ...result }, null, 2));
    return result.failed.length > 0 ? 1 : 0;
  }

  if (dryRun) deps.stdout('DRY RUN — nothing was downloaded.');
  const mb = (result.bytes / 1_048_576).toFixed(1);
  deps.stdout(
    `${dryRun ? 'Would back up' : 'Backed up'} ${result.saved.length} file(s)` +
      `${dryRun ? '' : ` (${mb} MB)`}, ${result.unchanged.length} already current.`,
  );
  deps.stdout(`  ${dest}`);
  for (const p of result.vanished) deps.stdout(`  · gone from the cloud, kept here: ${p}`);
  for (const f of result.failed) deps.stdout(`  ⚠ ${f.path}: ${f.reason}`);

  return result.failed.length > 0 ? 1 : 0;
}

async function cmdPush(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      date: { type: 'string' },
      file: { type: 'string' },
      replace: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  let path: string;
  if (values.file !== undefined) {
    path = values.file;
  } else {
    let date: string;
    try {
      date = values.date === undefined ? isoToday(deps.now()) : (resolveDate(values.date, deps.now()) ?? '');
    } catch (e) {
      deps.stderr((e as Error).message);
      return 1;
    }
    path = join(deps.outDir, `${date} 写汉字.note`);
  }

  if (!existsSync(path)) {
    deps.stderr(`No sheet at ${path}. Run \`xiehanzi generate\` first.`);
    return 1;
  }

  const bytes = readFileSync(path);
  const dryRun = values['dry-run'] === true;

  // A dry run needs the session too. It has to look at what is actually on the device
  // before it can say what a real run would do, and the alternative — answering without
  // looking — is how it came to report "would upload" for a sheet it would in fact refuse
  // to touch. Failing clearly beats answering confidently and wrongly.
  //
  // Prefer a saved session: two-factor makes a fresh login impossible unattended.
  const session = loadSession(deps.sessionPath);
  if (session === null) {
    deps.stderr('Not signed in to Supernote Cloud. Run `xiehanzi login` first.');
    return 1;
  }

  const cloud = deps.cloud();
  cloud.useToken(session.token);

  // A replacement first saves the file it is about to overwrite. The cloud's copy may be
  // the only one carrying his handwriting, and pushNote refuses to replace without this.
  const replacedDir = join(deps.outDir, 'replaced');
  const keepCopy = (entry: { fileName: string }, previous: Buffer): void => {
    mkdirSync(replacedDir, { recursive: true });
    const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
    const kept = join(replacedDir, `${stamp} ${entry.fileName}`);
    writeFileSync(kept, previous);
    deps.stdout(`Kept the previous copy at ${kept}`);
  };

  const result = await pushNote(cloud, deps.remoteDir, basename(path), bytes, {
    ...(values.replace === true ? { replace: true, keepCopy } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  if (json) {
    deps.stdout(JSON.stringify({ ...result, dryRun, bytes: bytes.length }, null, 2));
    return result.outcome === 'refused' ? 1 : 0;
  }

  if (dryRun) deps.stdout('DRY RUN — nothing was uploaded.');
  switch (result.outcome) {
    case 'uploaded':
      deps.stdout(`${dryRun ? 'Would upload' : 'Uploaded'} ${result.fileName} to ${result.remotePath}`);
      return 0;
    case 'replaced':
      deps.stdout(
        `${dryRun ? 'Would replace' : 'Replaced'} ${result.fileName} in ${result.remotePath}` +
          (dryRun ? ' — the device copy differs and --replace was given.' : ''),
      );
      if (result.leftover !== undefined) {
        deps.stdout(`The previous version is still on the cloud as ${result.leftover}; delete it by hand.`);
      }
      return 0;
    case 'unchanged':
      deps.stdout(
        `${result.fileName} is already on the device, unchanged.` +
          (dryRun ? ' Nothing would be uploaded.' : ''),
      );
      return 0;
    default:
      // Not a failure: the sheet is already on the device and we deliberately left the
      // handwriting alone. Exiting non-zero here would alarm the morning job every time
      // it re-ran after a day's practice, and an alarm channel that cries wolf is one you
      // stop reading. Callers that need to act on this can read outcome from --json.
      deps.stdout(
        `${dryRun ? 'Would leave alone' : 'Left alone'}: ` +
          `${result.reason ?? 'the device copy differs.'}`,
      );
      return 0;
  }
}

/** What `grade` and `regrade` both hand to `gradeSession`; they differ only in where the note comes from. */
function gradeDeps(
  deps: CliDeps,
  cloud: GradeDeps['cloud'],
  localNote?: GradeDeps['localNote'],
  recognisers: Recognisers = deps.recognisers(),
): GradeDeps {
  return {
    cloud,
    sheets: deps.sheets,
    reviews: deps.reviews,
    remoteDir: deps.remoteDir,
    fileName: (d) => `${d} 写汉字.note`,
    pageWidthMm: DEFAULT_SHEET_CONFIG.pageWidthMm,
    pageHeightMm: DEFAULT_SHEET_CONFIG.pageHeightMm,
    recognisers,
    // As of the graded date, not today: a re-grade of an older sheet must not count a
    // character introduced later as one Franco could have confused it with.
    eligible: (date) =>
      new Set(
        [...introducedDates(deps.sheets.allSheets(), handwritingChars(deps.catalogue()))]
          .filter(([, introduced]) => introduced <= date)
          .map(([char]) => char),
      ),
    confusionFrom: deps.confusionFrom,
    partnerMode: deps.partnerMode,
    maxStrokeDelta: deps.maxStrokeDelta,
    ...(localNote === undefined ? {} : { localNote }),
  };
}

async function cmdGrade(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      date: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  let date: string;
  try {
    date = values.date === undefined ? isoToday(deps.now()) : (resolveDate(values.date, deps.now()) ?? '');
  } catch (e) {
    deps.stderr((e as Error).message);
    return 1;
  }

  const dryRun = values['dry-run'] === true;

  // Unlike push, grading has nothing useful to preview without the network — a dry run
  // exists to show what verdicts WOULD be recorded, which means it has to actually pull
  // and read the note. But `gradeSession` checks the manifest and the "already graded"
  // idempotence guard *before* touching the network, so a session must not be required to
  // reach those checks — this runs unattended with email alerting on failure, and a date
  // with no sheet (or a stale session) must exit 0 quietly rather than alarm on a login
  // error for a day there was never anything to grade. The client is only built, and the
  // session only loaded, if `gradeSession` actually calls this factory — which it does at
  // most once, and only after every cheaper check has already passed.
  let notSignedIn = false;
  const cloud = () => {
    const client = deps.cloud();
    const session = loadSession(deps.sessionPath);
    if (session === null) {
      notSignedIn = true;
      throw new Error('Not signed in to Supernote Cloud. Run `xiehanzi login` first.');
    }
    client.useToken(session.token);
    return client;
  };

  let summary: GradeSummary;
  try {
    summary = await gradeSession(gradeDeps(deps, cloud), { date, ...(dryRun ? { dryRun: true } : {}) });
  } catch (e) {
    if (!notSignedIn) throw e;
    deps.stderr((e as Error).message);
    return 1;
  }

  if (json) {
    deps.stdout(JSON.stringify({ ...summary, dryRun }, null, 2));
    return 0;
  }

  if (dryRun) deps.stdout('DRY RUN — nothing was recorded.');

  switch (summary.skipped) {
    case 'no-sheet':
      // Covers two cases that look the same to the grader and different to a human: the
      // date has no sheet at all, or it has one that carries no recall rows. Naming both
      // keeps the evening log honest — "run generate first" would be wrong advice on a
      // day when the sheet exists and simply had nothing due.
      deps.stdout(
        `Nothing to grade for ${summary.date}: no sheet, or a sheet with no recall rows.`,
      );
      return 0;
    case 'already-graded':
      deps.stdout(`${summary.date} was already graded — nothing to do.`);
      return 0;
    case 'not-attempted':
      // The stamp is the whole diagnosis. "Not written on yet" is equally true of a device
      // that never uploaded and of a day Franco took off, and those need opposite
      // responses — one is a broken sync to chase, the other is nothing at all. A stamp
      // still reading this morning's push says nothing has been uploaded since; a stamp
      // from this evening says the upload landed and the sheet is genuinely blank. On
      // 2026-09-23 this line's silence cost a session spent dating the upload from a
      // backup job's log instead.
      deps.stdout(
        `${summary.date}'s sheet has not been written on yet.` +
          (summary.cloudUpdatedAt === null
            ? ''
            : ` The cloud copy was last updated ${new Date(summary.cloudUpdatedAt).toISOString()}.`),
      );
      return 0;
    case 'not-delivered':
      // Distinct wording on purpose: this is not "nothing to do yet", it is "the file
      // never made it to the device", which is what a stuck push or a broken sync looks
      // like — and unlike a skipped morning, it is worth someone actually noticing.
      deps.stdout(
        `${summary.date}'s sheet is not on Supernote Cloud — push may have failed, ` +
          'or the device has not synced back yet.',
      );
      return 0;
    case 'unreadable':
      // Exit 0 on purpose: the recognisers being down is not Franco's failure and not a
      // broken sync, and the seven-day nightly window retries it without anyone acting.
      deps.stdout(
        `${summary.date}: cells were written but no recogniser could read them; it will be retried on a later night.`,
      );
      return 0;
    case 'unchanged':
      deps.stdout(`${summary.date} re-graded; no verdict changed.`);
      return 0;
  }

  const verb = dryRun ? 'Would record' : 'Recorded';
  deps.stdout(
    `${verb} ${summary.graded} verdict${summary.graded === 1 ? '' : 's'} for ${summary.date} — ` +
      `${summary.passed} passed, ${summary.failed} failed.`,
  );
  const parts = Object.entries(summary.evidence)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`);
  if (parts.length > 0) deps.stdout(`  · ${parts.join(', ')}`);
  // Tier 1 is the configured pipeline in full: Google and the stroke gate, plus the partner
  // when the partner mode asked it. Tier 2 is Google without a partner the mode needed.
  const tierNames = { 1: 'full pipeline', 2: 'google without the partner', 3: 'partner only', 4: 'device' } as const;
  const tierParts = ([1, 2, 3, 4] as const).filter((t) => summary.tiers[t] > 0).map((t) => `${summary.tiers[t]} ${tierNames[t]}`);
  if (tierParts.length > 0) deps.stdout(`  · read by ${tierParts.join(', ')}`);
  if (summary.degraded) {
    deps.stdout('  · a recogniser it needs was unavailable — the nightly run re-grades it once it answers.');
  }
  if (summary.ungraded > 0) deps.stdout(`  · ${summary.ungraded} written cell(s) could not be read by anything; left ungraded for now.`);
  for (const char of summary.suspectedMisreads) {
    deps.stdout(`  ⚠ ${char}: failed 3+ times in a row with the same misreading — looks like a recogniser problem, not a memory one.`);
  }

  return 0;
}

/**
 * The morning gate: a new sheet only once the last one has been written on.
 *
 * An unwritten sheet is not joined by another — Franco asked for this on 2026-10-04, after
 * a weekend offline left two blank sheets with different dates on the device. Instead the
 * unwritten one is renamed to today, so the device always holds one sheet to do, named for
 * the day he does it. Its recall rows stay as they were: they are overdue, not lost, and
 * whatever has newly come due waits for the first fresh sheet.
 *
 * "Written on" is decided by grading the sheet, the same evidence the evening job uses: a
 * verdict (or ink nothing could read) means done; `not-attempted` and `not-delivered` mean
 * carry. A sheet without recall rows cannot be judged that way and never blocks.
 *
 * The three moves — manifest, local file, cloud file — happen in that order and each is
 * idempotent, so a run cut off anywhere is safe to repeat, and a caller that falls back to
 * `generate` after a failure gets a reprint of the carried manifest rather than a sheet
 * the manifest does not describe.
 */
async function cmdCarry(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { date: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });

  let today: string;
  try {
    today = values.date === undefined ? isoToday(deps.now()) : (resolveDate(values.date, deps.now()) ?? '');
  } catch (e) {
    deps.stderr((e as Error).message);
    return 1;
  }
  const dryRun = values['dry-run'] === true;
  const fileName = (d: string) => `${d} 写汉字.note`;

  const report = (decision: 'carried' | 'generate', reason: string, from?: string): number => {
    if (json) {
      deps.stdout(JSON.stringify({ decision, reason, to: today, ...(from === undefined ? {} : { from }), dryRun }, null, 2));
    } else {
      if (dryRun) deps.stdout('DRY RUN — nothing was moved.');
      deps.stdout(reason);
      deps.stdout(`decision: ${decision}`);
    }
    return 0;
  };

  const cloudClient = () => {
    const client = deps.cloud();
    const session = loadSession(deps.sessionPath);
    if (session === null) throw new Error('Not signed in to Supernote Cloud. Run `xiehanzi login` first.');
    client.useToken(session.token);
    return client;
  };

  // Puts the file on the cloud under today's name. Safe to repeat: once the old name is
  // gone or today's is there, there is nothing left to do (push uploads the local copy if
  // neither is on the cloud).
  const renameOnCloud = async (from: string): Promise<void> => {
    const cloud = cloudClient();
    const directoryId = await cloud.ensureDirectory(deps.remoteDir);
    const old = await cloud.findEntry(directoryId, fileName(from));
    if (old === undefined) return;
    if ((await cloud.findEntry(directoryId, fileName(today))) !== undefined) {
      deps.stdout(`  ⚠ both ${fileName(from)} and ${fileName(today)} are on the cloud; left both alone.`);
      return;
    }
    await cloud.renameEntry(old, fileName(today));
  };

  const existing = deps.sheets.getSheet(today);
  if (existing !== null) {
    const last = existing.carriedFrom?.at(-1);
    if (last === undefined) return report('generate', `${today} already has its own sheet.`);
    // A re-run after a carry that was cut off: finish the move rather than plan anew.
    if (!dryRun) await renameOnCloud(last);
    return report('carried', `${today} is the ${last} sheet carried forward.`, last);
  }

  const previous = deps.sheets.allSheets().filter((s) => s.date < today).at(-1);
  if (previous === undefined) return report('generate', 'No earlier sheet.');
  if (previous.recall === undefined || previous.recallGeometry === undefined) {
    return report('generate', `${previous.date} had no recall rows, so whether it was written on cannot be told.`);
  }

  const summary = await gradeSession(gradeDeps(deps, cloudClient), { date: previous.date, ...(dryRun ? { dryRun: true } : {}) });
  if (summary.skipped !== 'not-attempted' && summary.skipped !== 'not-delivered') {
    return report('generate', `${previous.date} was written on (${summary.skipped ?? 'graded now'}).`);
  }

  const from = previous.date;
  const why = summary.skipped === 'not-delivered' ? 'never reached the cloud' : 'has not been written on';
  if (dryRun) return report('carried', `Would carry ${from} to ${today}: it ${why}.`, from);

  deps.sheets.carrySheet(from, today);
  const oldPath = join(deps.outDir, fileName(from));
  const newPath = join(deps.outDir, fileName(today));
  if (existsSync(oldPath) && !existsSync(newPath)) renameSync(oldPath, newPath);
  await renameOnCloud(from);
  return report('carried', `Carried ${from} to ${today}: it ${why}.`, from);
}

/** Skip outcomes regrade must name: each leaves the date's earlier verdicts in force. */
const REGRADE_SKIPS = new Set<GradeSummary['skipped']>(['no-sheet', 'not-delivered', 'not-attempted', 'unreadable']);

async function cmdRegrade(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { from: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    allowPositionals: false,
    strict: true,
  });
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (values.from === undefined || !isoDate.test(values.from)) {
    deps.stderr('regrade needs --from=YYYY-MM-DD.');
    return 1;
  }
  const from = values.from;
  const today = isoToday(deps.now());
  // Yesterday, never today: today's sheet may still be being written, and force-grading it
  // would record a complete-looking revision 0 that the nightly run then calls finished.
  const to = values.to ?? addDays(today, -1);
  if (!isoDate.test(to)) {
    deps.stderr('regrade needs --to=YYYY-MM-DD.');
    return 1;
  }
  if (to >= today) {
    deps.stderr(`regrade --to must be before today (${today}): today's sheet may still be being written.`);
    return 1;
  }
  if (from > to) {
    deps.stderr(`regrade --from (${from}) is after --to (${to}).`);
    return 1;
  }

  // Regrade is attended and reaches outside the nightly seven-day window, so anything it
  // writes degraded stays degraded for good. Refuse rather than grade without a recogniser
  // the partner mode needs. With the partner off, Google alone is the full pipeline.
  const recognisers = deps.recognisers();
  const partnerUsed = deps.partnerMode !== 'off';
  const missing = [
    recognisers.google === null ? 'Google' : null,
    partnerUsed && recognisers.partner === null ? 'the partner vision model' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) {
    deps.stderr(
      `regrade needs ${partnerUsed ? 'both recognisers' : 'Google'}, but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not configured. Nothing was graded.`,
    );
    return 1;
  }
  const dryRun = values['dry-run'] === true;

  // The backup holds every written sheet and is read first: re-grading weeks of history
  // must not mean weeks of cloud downloads. The cloud is only the fallback.
  const localNote = (date: string): Buffer | null => {
    const path = join(deps.backupDir, deps.remoteDir, `${date} 写汉字.note`);
    return existsSync(path) ? readFileSync(path) : null;
  };
  const cloud = () => {
    const client = deps.cloud();
    const session = loadSession(deps.sessionPath);
    if (session === null) throw new Error('Not signed in to Supernote Cloud. Run `xiehanzi login` first.');
    client.useToken(session.token);
    return client;
  };

  const introduced = introducedDates(deps.sheets.allSheets(), handwritingChars(deps.catalogue()));
  const before = deps.reviews.all();
  const pending: Review[] = [];
  const summaries: GradeSummary[] = [];
  // Every date whose verdicts did not come out of a full, fresh grading, so the run Franco
  // approves cannot quietly differ from the one he thinks he approved.
  const skipped: { date: string; reason: string }[] = [];
  const degraded: { date: string; reason: string }[] = [];
  const errored: { date: string; error: string }[] = [];

  const sheets = deps.sheets.allSheets()
    .filter((s) => s.recall !== undefined && s.date >= from && s.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const sheet of sheets) {
    const { date } = sheet;
    // Without a gap after the first cell, the crop margin around it reaches the printed
    // correction ink, and the partner would see the printed answer inside the handwriting
    // image itself, not only as its reference. The spec keeps those sheets' verdicts as
    // they are.
    if ((sheet.recallGeometry?.firstCellGapMm ?? 0) <= 0) {
      skipped.push({ date, reason: 'no first-cell gap' });
      continue;
    }
    let summary: GradeSummary;
    try {
      summary = await gradeSession(gradeDeps(deps, cloud, localNote, recognisers), { date, force: true, dryRun });
    } catch (e) {
      // One bad date (a cloud 5xx, an unreadable file) must not cost the rest of the range.
      errored.push({ date, error: (e as Error).message });
      continue;
    }
    summaries.push(summary);
    pending.push(...summary.recorded);
    if (REGRADE_SKIPS.has(summary.skipped)) skipped.push({ date, reason: summary.skipped! });
    // Independent of `skipped`: an unchanged date can still be degraded.
    if (summary.degraded || summary.ungraded > 0) {
      degraded.push({
        date,
        reason: summary.ungraded > 0
          ? `${summary.ungraded} written cell(s) nothing could read`
          : 'a recogniser it needs was unavailable',
      });
    }
  }

  const flips = summaries.flatMap((s) => s.changes.map((c) => ({ date: s.date, ...c })));
  const toFail = flips.filter((c) => c.from === 'pass' && c.to === 'fail').length;
  const toPass = flips.filter((c) => c.from === 'fail' && c.to === 'pass').length;

  // A dry run appended nothing, so its "after" is the log plus what would have been recorded.
  const after = dryRun ? [...before, ...pending] : deps.reviews.all();
  const schedulesBefore = replay(introduced, before);
  const schedulesAfter = replay(introduced, after);
  const dueToday = (schedules: ReturnType<typeof replay>) =>
    [...schedules.values()].filter((s) => s.due <= today).length;
  const dueBefore = dueToday(schedulesBefore);
  const dueNow = dueToday(schedulesAfter);
  // What each change does to that character's next review. A character no longer
  // introduced has no schedule at all, shown as null.
  const dueChanges = [...new Set(flips.map((f) => f.char))].map((char) => ({
    char,
    before: schedulesBefore.get(char)?.due ?? null,
    after: schedulesAfter.get(char)?.due ?? null,
  }));

  const code = errored.length > 0 || degraded.length > 0 ? 1 : 0;

  if (json) {
    deps.stdout(JSON.stringify(
      { dryRun, flips, toFail, toPass, dueBefore, dueAfter: dueNow, dueChanges, skipped, degraded, errored },
      null,
      2,
    ));
    return code;
  }

  if (dryRun) deps.stdout('DRY RUN — nothing was recorded.');
  for (const s of summaries) {
    if (s.changes.length === 0) continue;
    const parts = s.changes.map((c) => `${c.char} ${c.from ?? '—'} → ${c.to ?? '—'}`);
    deps.stdout(`${s.date}  ${parts.join(', ')}${s.degraded ? '  (degraded)' : ''}`);
  }
  if (dueChanges.length > 0) {
    deps.stdout('Next due:');
    for (const d of dueChanges) deps.stdout(`  ${d.char} ${d.before ?? '—'} → ${d.after ?? '—'}`);
  }
  for (const s of skipped) deps.stdout(`skipped   ${s.date}: ${s.reason}`);
  for (const d of degraded) deps.stdout(`degraded  ${d.date}: ${d.reason}`);
  for (const e of errored) deps.stdout(`error     ${e.date}: ${e.error}`);
  deps.stdout(
    `${flips.length} change(s) across ${sheets.length} date(s): ${toFail} pass → fail, ${toPass} fail → pass; ` +
      `${skipped.length} skipped, ${degraded.length} degraded, ${errored.length} errored.`,
  );
  deps.stdout(`Characters due today: ${dueBefore} before, ${dueNow} after.`);
  return code;
}

async function cmdQueue(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  parseArgs({ args: rest, allowPositionals: true, strict: true });

  // Far enough ahead to include anything pinned to a future date.
  const horizon = '9999-12-31';
  const pending = deps.queue.pending(horizon);

  if (json) {
    deps.stdout(JSON.stringify({ pending }, null, 2));
    return 0;
  }

  if (pending.length === 0) {
    deps.stdout('Nothing queued.');
    return 0;
  }

  deps.stdout(`${pending.length} character${pending.length === 1 ? '' : 's'} queued:`);
  for (const entry of pending) {
    const when = entry.date === null ? 'next sheet' : entry.date;
    const from = entry.sourceWord !== undefined && entry.sourceWord !== entry.char
      ? ` (from ${entry.sourceWord})`
      : '';
    deps.stdout(`  ${entry.char}  ${when}${from}`);
  }
  return 0;
}

async function cmdLookup(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true });
  const term = positionals[0];
  if (term === undefined) {
    deps.stderr('Give a term to look up.');
    return 1;
  }

  const entries = deps.dictionary().lookup(term);

  if (json) {
    deps.stdout(JSON.stringify({ term, entries }, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    deps.stdout(`No entry for ${term} in CC-CEDICT. Not unusual for phrases — write it yourself.`);
    return 0;
  }

  deps.stdout(term);
  for (const entry of entries) {
    deps.stdout(`  ${entry.pinyin}  ${entry.definitions.join('; ')}`);
  }
  return 0;
}

async function cmdLearn(rest: string[], deps: CliDeps, json: boolean): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      pinyin: { type: 'string' },
      meaning: { type: 'string' },
      sentence: { type: 'string' },
      translation: { type: 'string' },
      emoji: { type: 'string' },
      deck: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });

  const term = positionals[0];
  if (term === undefined) {
    deps.stderr('Give a term to learn.');
    return 1;
  }
  if (values.pinyin === undefined || values.meaning === undefined) {
    deps.stderr('Both --pinyin and --meaning are required. Run `xiehanzi lookup` first to check them.');
    return 1;
  }

  const dryRun = values['dry-run'] === true;

  const result = await learn(
    {
      term,
      pinyin: values.pinyin,
      meaning: values.meaning,
      ...(values.sentence === undefined ? {} : { sentence: values.sentence }),
      ...(values.translation === undefined ? {} : { translation: values.translation }),
      ...(values.emoji === undefined ? {} : { emoji: values.emoji }),
      ...(values.deck === undefined ? {} : { deck: values.deck }),
    },
    {
      anki: deps.anki(),
      backup: deps.backup,
      dictionary: deps.dictionary(),
      enqueue: (chars) => {
        deps.queue.add(chars);
      },
      now: deps.now,
      skip: deps.skip,
    },
    { dryRun },
  );

  if (json) {
    deps.stdout(JSON.stringify(result, null, 2));
    return 0;
  }

  // Past tense is a claim. On a dry run nothing happened, so say so first and describe
  // the rest conditionally — the caller is an agent that will repeat this verbatim.
  if (result.dryRun) deps.stdout('DRY RUN — nothing was written.');

  const verb = result.dryRun
    ? result.created ? 'Would create' : 'Would reuse'
    : result.created ? 'Created' : 'Found';
  const scheduled =
    result.action === 'none'
      ? 'already in today’s learning session, would be left alone'
      : result.action === 'answerCards'
        ? `${result.dryRun ? 'would be answered' : 'answered'} Again — due again today`
        : `${result.dryRun ? 'would be made' : ''} due today`.trim();
  deps.stdout(`${verb} ${result.term} — ${result.bucket} card, ${scheduled}.`);

  const d = result.dictionary;
  if (d.matched && d.agrees === false) {
    deps.stdout(`  ⚠ CC-CEDICT says "${d.pinyin}" (${d.definitions?.[0] ?? ''}) — you passed a different reading.`);
  } else if (!d.matched) {
    deps.stdout('  · not in CC-CEDICT, so pinyin was not cross-checked.');
  }

  if (result.enqueuedChars.length > 0) {
    const q = result.dryRun ? 'would queue for practice' : 'queued for practice';
    deps.stdout(`  · ${q}: ${result.enqueuedChars.join(' ')}`);
  }
  if (!result.dryRun && !result.synced) {
    deps.stdout(`  ⚠ AnkiWeb sync failed: ${result.syncError ?? 'unknown'}`);
  }

  return 0;
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');

  if (args.length === 0) {
    deps.stderr(USAGE);
    return 1;
  }
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    deps.stdout(USAGE);
    return 0;
  }

  const [command, ...rest] = args as [string, ...string[]];

  try {
    switch (command) {
      case 'add':
        return await cmdAdd(rest, deps, json);
      case 'learn':
        return await cmdLearn(rest, deps, json);
      case 'lookup':
        return await cmdLookup(rest, deps, json);
      case 'queue':
        return await cmdQueue(rest, deps, json);
      case 'generate':
        return await cmdGenerate(rest, deps, json);
      case 'glossary':
        return await cmdGlossary(rest, deps, json);
      case 'push':
        return await cmdPush(rest, deps, json);
      case 'grade':
        return await cmdGrade(rest, deps, json);
      case 'regrade':
        return await cmdRegrade(rest, deps, json);
      case 'carry':
        return await cmdCarry(rest, deps, json);
      case 'backup':
        return await cmdBackup(rest, deps, json);
      case 'login':
        return await cmdLogin(rest, deps, json);
      default:
        deps.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    deps.stderr((e as Error).message);
    return 1;
  }
}

/** Builds the real dependencies. Dictionary and Anki are lazy — `add` needs neither. */
function realDeps(): CliDeps {
  const root = repoRoot();
  const delivery = readJson<{ deliverDir: string; remoteDir: string; backupDir: string }>(
    join(root, 'config/delivery.json'),
  );
  // Credentials live in .env, never in config or the repo.
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const decksFile = readJson<{ host: string; searchDeck?: string }>(join(root, 'config/decks.json'));
  const decks = { host: decksFile.host, searchDeck: decksFile.searchDeck ?? 'HSK 3.0 Vocabulary' };
  const skip = readJson<{ characters: string[] }>(join(root, 'config/skip.json'));
  const recognition = loadRecognitionConfig(join(root, 'config/recognition.json'));
  let recognisers: Recognisers | undefined;

  let dictionary: Dictionary | undefined;
  let examples: ExampleIndex | undefined;
  let glossary: Glossary | undefined;
  let catalogue: HskCatalogue | undefined;
  let anki: AnkiClient | undefined;
  let vocab: VocabSource | undefined;

  const ankiClient = (): AnkiClient => (anki ??= createAnkiClient({ host: decks.host }));

  return {
    queue: createQueueStore(join(root, 'state/queue.json')),
    sheets: createSheetStore(join(root, 'state/sheets.json')),
    reviews: createReviewStore(join(root, 'state/reviews.json')),
    dictionary: () => (dictionary ??= loadDictionary(join(root, 'data/cedict.txt.gz'))),
    examples: () =>
      (examples ??= createExampleIndex(loadHskWords(join(root, 'data/hsk30-wordlist.txt')))),
    glossary: () => (glossary ??= loadGlossary(join(root, 'data/anki-glossary.json'))),
    glossaryPath: join(root, 'data/anki-glossary.json'),
    glossaryDeck: decks.searchDeck,
    catalogue: () =>
      (catalogue ??= loadHsk(
        join(root, 'data/hsk30-charlist.txt'),
        join(root, 'data/char-frequency.txt'),
      )),
    anki: ankiClient,
    vocab: () => (vocab ??= createAnkiVocabSource(ankiClient(), { deck: decks.searchDeck })),
    writePdf: (html, path) => renderPdf(html, path),
    writeNoteFile: async (html, path, styleStem) => {
      const backgrounds = await renderPageBitmaps(html, {
        pageWidthMm: DEFAULT_SHEET_CONFIG.pageWidthMm,
        pageHeightMm: DEFAULT_SHEET_CONFIG.pageHeightMm,
      });
      const note = writeNote(
        // Seeded by the sheet name: regenerating a date must reproduce the same bytes,
        // or push cannot tell an unchanged sheet from one that has been written on.
        backgrounds.map((background, i) => ({
          background,
          // Built-in name on purpose; a custom one hangs the device.
        })),
        {
          seed: styleStem,
          // Real-time recognition: the device transcribes each character as it is written
          // and stores the labels, with bounding boxes, inside the file. That is what
          // makes automatic assessment possible without OCR or self-reporting.
          recognitionLanguage: 'zh_CN',
        },
      );
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, note);
    },
    // One machine may write straight into a synced notes folder while another only stages
    // the file before pushing, so the location is overridable per machine.
    outDir: expandHome(process.env.XIEHANZI_DELIVER_DIR ?? delivery.deliverDir),
    remoteDir: delivery.remoteDir,
    backupDir: expandHome(delivery.backupDir),
    sessionPath: join(root, '.supernote-session.json'),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    cloud: () =>
      createCloudClient({
        account: process.env.SUPERNOTE_EMAIL ?? '',
        password: process.env.SUPERNOTE_PASSWORD ?? '',
      }),
    backup: backupFromEnv(),
    recognisers: () =>
      (recognisers ??= buildRecognisers(
        recognition,
        loadGoKey(process.env, join(homedir(), '.local/share/opencode/auth.json')),
      )),
    confusionFrom: recognition.confusionFrom,
    partnerMode: recognition.partnerMode,
    maxStrokeDelta: recognition.maxStrokeDelta,
    now: () => new Date(),
    skip: skip.characters,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

// Compare real paths, not a URL against a path: import.meta.url percent-encodes the
// non-ASCII characters in this repo's directory name, so string equality never holds.
const entry = process.argv[1];
const isMain = entry !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(entry);
if (isMain) {
  process.exitCode = await run(process.argv.slice(2), realDeps());
}
