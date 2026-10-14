/**
 * Pulls the day's written-on note back from Supernote Cloud, grades every recall row on
 * it against the geometry that sheet was actually printed with, and appends the verdicts
 * to the review log.
 *
 * This is the other end of `generate`: `generate` decides what to ask and where it lands
 * on the page; this reads back what was written and turns it into schedule input. Nothing
 * here recomputes layout — a config change between generating and grading a sheet must
 * not change how that sheet is scored.
 */

import { readNote } from '../deliver/note/read.js';
import { assessPage, type TierCounts } from './assess.js';
import { mergeDay, type PartnerMode } from './verdict.js';
import { latestRevisions, type Review } from './schedule.js';
import type { SupernoteCloud } from '../deliver/supernote/cloud.js';
import type { SheetStore, RecallRow } from '../state/sheets.js';
import type { ReviewStore } from '../state/reviews.js';
import type { Recognisers } from './recognise/http.js';

export type GradeDeps = {
  /**
   * Lazy on purpose. Acquiring a usable client can mean loading a saved session and can
   * fail outright if there is none — real work that must not happen for a date that turns
   * out to have nothing to grade. Called at most once per `gradeSession`, and only after
   * every check that could avoid it has already passed.
   */
  cloud: () => SupernoteCloud | Promise<SupernoteCloud>;
  sheets: SheetStore;
  reviews: ReviewStore;
  /** Folder on Supernote Cloud the device syncs down, same as `push`'s. */
  remoteDir: string;
  /** The delivered filename for a date, matching whatever `generate`/`push` used. */
  fileName: (date: string) => string;
  pageWidthMm: number;
  pageHeightMm: number;
  /** Google reads the strokes; the partner vision model checks a pass. Either may be null: unconfigured. */
  recognisers: Recognisers;
  /**
   * Characters a cell on `date` may be confused with: those drilled on or before that date.
   * Dated, because re-grading an older sheet must not count a character Franco had not been
   * taught yet as a confusion. Read once per session.
   */
  eligible: (date: string) => ReadonlySet<string>;
  /** First sheet date the confusion rule applies to. Earlier dates grade as they always did. */
  confusionFrom: string;
  /** When the partner is asked; see verdict.ts. Under 'off', Google alone is not degraded. */
  partnerMode: PartnerMode;
  /** A Google pass more than this many strokes off the reference is a fail. */
  maxStrokeDelta: number;
  /**
   * A copy of the note already on this machine, or null to fetch it from the cloud. Checked
   * first: re-grading a date that was already downloaded need not touch the network.
   */
  localNote?: (date: string) => Buffer | null;
};

export type GradeOptions = {
  date: string;
  /** Grades and reports as usual, but never appends — for previewing verdicts before committing them. */
  dryRun?: boolean;
  /** Grade a date even when it is already graded in full, recording only what changed. */
  force?: boolean;
};

export type GradeSummary = {
  date: string;
  graded: number;
  passed: number;
  failed: number;
  evidence: { transcription: number; ink: number; recognition: number; confusion: number };
  /**
   * Two distinct "nothing to grade" outcomes that must not collapse into one message.
   * `not-delivered` — the file is not on Supernote Cloud at all: push failed, or the
   * device never synced back. This is the shape a PERMANENT breakage takes, and it must
   * stay diagnosable in the logs rather than reading like an ordinary skipped morning.
   * `not-attempted` — the file came back, but has no ink anywhere: an ordinary day the
   * sheet was not opened, or (for the empty-`reviews` case) had nothing gradeable on it.
   * `unreadable` — cells WERE written, but no recogniser could read any of them. Not a day
   * off: the recognisers were down or unconfigured, and the nightly run should try again.
   * `unchanged` — graded again, and every verdict matched the ones already counting.
   */
  skipped: 'already-graded' | 'no-sheet' | 'not-delivered' | 'not-attempted' | 'unreadable' | 'unchanged' | null;
  /**
   * When Supernote Cloud last saw a new version of this file, or `null` when no file was
   * found (or the date never reached the cloud at all).
   *
   * Carried purely so the log can answer a question a 'not-attempted' outcome otherwise
   * poses without answering: did the device never upload, or did Franco genuinely not
   * write? Those read identically and need opposite responses — one is a broken sync, the
   * other is a day off. A stamp still reading the morning's push settles it instantly.
   */
  cloudUpdatedAt: number | null;
  suspectedMisreads: string[];
  /** How many cells each verdict tier decided; see `CellVerdict.tier`. */
  tiers: TierCounts;
  /** Graded without every recogniser the partner mode needs, somewhere; the nightly run grades it again. */
  degraded: boolean;
  /** Written cells nothing could read. Never passed; they make the date degraded. */
  ungraded: number;
  /** Revision of the verdicts that now count for this date. */
  revision: number;
  /** Exactly what was (or, on a dry run, would have been) appended. */
  recorded: Review[];
  /** Per-character pass/fail differences from the verdicts that counted before. */
  changes: { char: string; from: 'pass' | 'fail' | null; to: 'pass' | 'fail' | null }[];
};

/** Three in a row is enough to distinguish a pattern from coincidence without waiting so
 * long that a real recogniser bug goes unreported for weeks. */
const MISREAD_STREAK = 3;

function emptySummary(
  date: string,
  skipped: GradeSummary['skipped'],
  cloudUpdatedAt: number | null = null,
): GradeSummary {
  return {
    date,
    graded: 0,
    passed: 0,
    failed: 0,
    evidence: { transcription: 0, ink: 0, recognition: 0, confusion: 0 },
    skipped,
    cloudUpdatedAt,
    suspectedMisreads: [],
    tiers: { 1: 0, 2: 0, 3: 0, 4: 0 },
    degraded: false,
    ungraded: 0,
    revision: 0,
    recorded: [],
    changes: [],
  };
}

/**
 * Characters with three or more CONSECUTIVE failures — read oldest to newest, per
 * character — that all carry the identical `read` from a recogniser: a transcription or
 * recognition fail. An ink verdict reads nothing, and a confusion fail's `read` is the
 * character itself (it was failed for being written in another's place, not misread), so
 * both can only ever break a streak, never extend one. Only the latest revision of each
 * date counts: a verdict since corrected by a re-grade is not evidence of anything.
 *
 * A person who has forgotten a character writes something different wrong each time; a
 * recogniser that misreads a correctly-written glyph is wrong the same way every time.
 * That is a real signal, but it is about the recogniser, not about Franco's memory — so
 * this only reports, it never touches the schedule.
 */
function suspectedMisreads(reviews: readonly Review[]): string[] {
  const byChar = new Map<string, Review[]>();
  for (const r of latestRevisions(reviews)) {
    const list = byChar.get(r.char);
    if (list === undefined) byChar.set(r.char, [r]);
    else list.push(r);
  }

  const flagged: string[] = [];
  for (const [char, list] of byChar) {
    // Stable sort: reviews sharing a date keep the order they were appended in, which is
    // the only order that exists for same-day verdicts.
    const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date));

    // The CURRENT trailing streak, not "did a streak of 3 ever occur anywhere in history".
    // Walking the whole history and stopping at the first point a streak reaches 3 would
    // flag a character forever the moment it happened once, even after clean passes since
    // — a person who keeps forgetting a character writes different wrong things each time,
    // so later variety (or a run of passes) breaking the streak is itself evidence the
    // recogniser problem, if it was one, is no longer the live explanation.
    let streakRead: string | null = null;
    let streak = 0;
    for (const r of ordered) {
      const misreadCandidate =
        r.result === 'fail' && (r.evidence === 'transcription' || r.evidence === 'recognition') ? r.read : undefined;
      if (misreadCandidate !== undefined && misreadCandidate === streakRead) {
        streak += 1;
      } else if (misreadCandidate !== undefined) {
        streakRead = misreadCandidate;
        streak = 1;
      } else {
        streakRead = null;
        streak = 0;
      }
    }
    if (streak >= MISREAD_STREAK) flagged.push(char);
  }
  return flagged;
}

export async function gradeSession(deps: GradeDeps, options: GradeOptions): Promise<GradeSummary> {
  const { date } = options;

  // Checking the manifest first — before any cloud call — means a date that predates
  // recall, or was never generated, costs nothing but a local read.
  const manifest = deps.sheets.getSheet(date);
  if (manifest === null || manifest.recall === undefined || manifest.recallGeometry === undefined) {
    return emptySummary(date, 'no-sheet');
  }

  // Idempotence by date, now revision-aware: the scheduled job retries on failure, and a
  // doubled review would double-advance the interval it feeds. A date whose verdicts all
  // came from the full configured pipeline is done; one graded degraded is graded again until
  // it is not. `force` grades again regardless, and records only what changed.
  const latest = deps.reviews.latestForDate(date);
  const latestDegraded = latest.some((r) => r.degraded === true);
  if (latest.length > 0 && !latestDegraded && options.force !== true) {
    return emptySummary(date, 'already-graded');
  }

  const rowsByPage = new Map<number, RecallRow[]>();
  for (const row of manifest.recall) {
    const list = rowsByPage.get(row.page);
    if (list === undefined) rowsByPage.set(row.page, [row]);
    else list.push(row);
  }

  const confusion = date >= deps.confusionFrom;
  const eligible = deps.eligible(date);
  const geometry = manifest.recallGeometry;
  const assessNote = async (note: ReturnType<typeof readNote>) => {
    const tiers: TierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let ungraded = 0;
    const ungradedChars = new Set<string>();
    const collected: Review[] = [];
    for (const [pageIndex, rows] of rowsByPage) {
      const page = note.pages[pageIndex];
      if (page === undefined) continue;
      const out = await assessPage({
        page,
        rows,
        geometry,
        date,
        pageWidthMm: deps.pageWidthMm,
        pageHeightMm: deps.pageHeightMm,
        recognisers: deps.recognisers,
        eligible,
        confusion,
        partnerMode: deps.partnerMode,
        maxStrokeDelta: deps.maxStrokeDelta,
      });
      collected.push(...out.reviews);
      ungraded += out.ungraded;
      for (const c of out.ungradedChars) ungradedChars.add(c);
      for (const t of [1, 2, 3, 4] as const) tiers[t] += out.tiers[t];
    }
    return { tiers, ungraded, ungradedChars, collected };
  };

  let assessed: Awaited<ReturnType<typeof assessNote>> | null = null;
  let cloudUpdatedAt: number | null = null;
  const local = deps.localNote?.(date) ?? null;
  if (local !== null) {
    assessed = await assessNote(readNote(local));
  } else {
    // Every check that could make the network unnecessary has now passed, so this is the
    // first point a session is actually required.
    const cloud = await deps.cloud();
    const directoryId = await cloud.ensureDirectory(deps.remoteDir);
    // A sheet carried forward from an unwritten day was renamed to this date on the cloud,
    // but the device may have been holding ink under the old name when that happened — a
    // sheet written offline the evening before, still unsynced at 06:20. Whatever the
    // firmware then does with the rename, the ink can come back under the old name. So the
    // date's own name is tried first and every name it was carried from after it, newest
    // first, and the first copy with anything written on it is the one graded. A manifest
    // that was never carried has one name and behaves exactly as before.
    const names = [date, ...[...(manifest.carriedFrom ?? [])].reverse()];
    let found = false;
    for (const name of names) {
      const entry = await cloud.findEntry(directoryId, deps.fileName(name));
      if (entry === undefined) continue;
      const candidate = await assessNote(readNote(await cloud.downloadFile(entry)));
      const written = candidate.collected.length > 0 || candidate.ungraded > 0;
      if (!found || written) {
        assessed = candidate;
        cloudUpdatedAt = entry.updateTime;
      }
      found = true;
      if (written) break;
    }
    // Distinct from a note that came back unwritten: this file is not on the cloud AT ALL,
    // which is the shape a permanent breakage (a failed push, a device that stopped syncing)
    // takes. Collapsing this into the same 'not-attempted' outcome as an ordinary skipped
    // morning is exactly what would let that breakage run silently for weeks.
    if (!found) return emptySummary(date, 'not-delivered');
  }
  const { tiers, ungraded, ungradedChars } = assessed!;
  let collected = assessed!.collected;

  // A cell that could not be read this time keeps the verdict it already had. A new
  // revision replaces the whole date in replay, so omitting it would let one night's
  // recogniser outage erase verdicts that count. The date stays degraded (ungraded > 0), so
  // the nightly run keeps trying to read it.
  //
  // Two exceptions. A legacy `ink` PASS is dropped rather than kept: it only ever meant
  // "something was written here", which is the exact false pass re-grading exists to
  // remove, so an unreadable cell shows as `pass → —` instead of hiding behind it. And a
  // confusion fail is matched by the cell that ASKED, never by the character it names: if
  // the asking cell was just read again, its old confusion is stale.
  const carried = latest.filter((r) =>
    r.evidence === 'confusion'
      ? r.asked !== undefined && ungradedChars.has(r.asked)
      : ungradedChars.has(r.char) && !(r.evidence === 'ink' && r.result === 'pass'),
  );

  // A sheet with no ink records nothing — absence of a record, not a failure, is what
  // carries every item forward to the next time it comes due. With nothing freshly read,
  // a revision is only worth writing when it would drop a legacy ink pass while keeping
  // something else; a revision with no records cannot be expressed in an append-only log,
  // so a date whose only verdicts are dropped ink passes stays as it is and reports
  // `unreadable`, which regrade lists.
  if (collected.length === 0 && (carried.length === 0 || carried.length === latest.length)) {
    return { ...emptySummary(date, ungraded > 0 ? 'unreadable' : 'not-attempted', cloudUpdatedAt), ungraded };
  }
  collected.push(...carried);

  // A date is degraded as a whole when any of its cells was: the nightly run re-grades
  // whole dates, and one revision must describe one consistent grading.
  const degraded = ungraded > 0 || collected.some((r) => r.degraded === true);
  collected = mergeDay(collected).map((r) => {
    const { degraded: _cell, revision: _rev, ...rest } = r;
    return degraded ? { ...rest, degraded: true } : rest;
  });

  // With no earlier verdicts this is revision 0, and its records carry no `revision` field
  // at all: exactly the shape every review written before revisions existed has.
  const previousRevision = latest.reduce((m, r) => Math.max(m, r.revision ?? 0), latest.length > 0 ? 0 : -1);
  const revision = previousRevision + 1;
  const recorded = revision === 0 ? collected : collected.map((r) => ({ ...r, revision }));
  const changes = diffVerdicts(latest, recorded);

  // Record when there was nothing before, when verdicts changed, or when a degraded date
  // has now been graded properly. An identical re-grade adds nothing to the log.
  const shouldRecord = latest.length === 0 || changes.length > 0 || (latestDegraded && !degraded);
  if (!shouldRecord) {
    return {
      ...emptySummary(date, 'unchanged', cloudUpdatedAt),
      tiers,
      degraded,
      ungraded,
      revision: previousRevision,
    };
  }
  if (options.dryRun !== true) deps.reviews.append(recorded);

  const passed = recorded.filter((r) => r.result === 'pass').length;
  const count = (e: Review['evidence']) => recorded.filter((r) => r.evidence === e).length;

  // A dry run reports the same signal a real run would, without needing to actually
  // commit today's reviews first — so the log to scan is today's reviews plus whatever is
  // already on record, rather than a re-read of a store that was never written to.
  const history = options.dryRun === true ? [...deps.reviews.all(), ...recorded] : deps.reviews.all();

  return {
    date,
    graded: recorded.length,
    passed,
    failed: recorded.length - passed,
    evidence: {
      transcription: count('transcription'),
      ink: count('ink'),
      recognition: count('recognition'),
      confusion: count('confusion'),
    },
    skipped: null,
    cloudUpdatedAt,
    suspectedMisreads: suspectedMisreads(history),
    tiers,
    degraded,
    ungraded,
    revision: Math.max(revision, 0),
    recorded,
    changes,
  };
}

/** Per-character pass/fail differences between the verdicts that counted and the new ones. */
function diffVerdicts(before: readonly Review[], after: readonly Review[]): GradeSummary['changes'] {
  const was = new Map(before.map((r) => [r.char, r.result]));
  const now = new Map(after.map((r) => [r.char, r.result]));
  const chars = [...new Set([...was.keys(), ...now.keys()])];
  return chars
    .filter((c) => was.get(c) !== now.get(c))
    .map((c) => ({ char: c, from: was.get(c) ?? null, to: now.get(c) ?? null }));
}
