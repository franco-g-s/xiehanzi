/**
 * Composes a day's sheet: manual pins first, then double-down review, then linear
 * catch-up for whatever is left.
 *
 * Planning is separated from rendering so the choice of characters can be tested — and
 * inspected with --dry-run — without a browser or a PDF.
 */

import type { HskCatalogue } from './sources/hsk.js';
import type { VocabSource } from './sources/vocab.js';
import type { QueueStore } from './state/queue.js';
import type { SheetStore, SheetCharacter, SheetManifest } from './state/sheets.js';
import type { ReviewStore } from './state/reviews.js';
import { buildLinearSequence, selectLinear } from './select/linear.js';
import { selectDoubleDown } from './select/doubledown.js';
import type { SelectionReason } from './select/enrich.js';
import { latestRevisions, replay } from './recall/schedule.js';
import type { Review } from './recall/schedule.js';
import { introducedDates, dueItems, needsRelearning } from './recall/pool.js';

export type GenerateDeps = {
  catalogue: HskCatalogue;
  queue: QueueStore;
  sheets: SheetStore;
  /** Absent or unreachable means linear-only; it must never stop the sheet. */
  vocab?: VocabSource;
  /** Absent means the caller has not adopted recall; the drill sheet still generates. */
  reviews?: ReviewStore;
  skip: string[];
  now: () => Date;
};

export type GenerateOptions = {
  date?: string;
  count?: number;
  /** How many of the day's characters come from review rather than the HSK march. */
  doubleDownCount?: number;
  force?: boolean;
  includeAnkiExtras?: boolean;
};

export type GenerateResult = {
  date: string;
  characters: SheetCharacter[];
  /** True when an existing sheet for this date was returned unchanged. */
  reused: boolean;
  counts: Record<SelectionReason, number>;
  warnings: string[];
};

/** A due recall item, bare — the caller enriches it into a `RecallPlan` for rendering. */
export type RecallSelection = { char: string; due: string; lapses: number };

/**
 * One drill page a day, at 9 rows a page.
 *
 * This was 18 — two full pages. Four days of real data showed recall pass rates falling
 * 70% → 70% → 50% → 10%, with 92 of 132 drilled characters never tested at all, and the
 * cause was arithmetic rather than difficulty: 18 new characters a day against a recall
 * capacity of 10 grows the queue by ~8 a day, so a character's first recall test — due one
 * day after it is drilled — actually landed 3-5 days later. Retention measured against that
 * lag: 75% passed at 3 days, 42% at 4, 25% at 5. Intake has to sit under recall capacity
 * (now ~20 a day, two recall pages) for the schedule to run at the interval it claims.
 */
export const DEFAULT_COUNT = 9;

/**
 * No Anki on an ordinary morning.
 *
 * The double-down pull is review vocabulary, and review is exactly what the recall half of
 * the sheet already does — on a schedule, with grading behind it. Spending drill slots on a
 * second, unscheduled review pass is what left the linear HSK march too little room. The
 * integration stays: `xiehanzi learn` still writes to Anki, and `--review=N` turns this back
 * on for anyone who wants it. At 0 the vocabulary source is never consulted at all.
 */
export const DEFAULT_DOUBLE_DOWN = 0;

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function tally(characters: readonly SheetCharacter[]): Record<SelectionReason, number> {
  const counts: Record<SelectionReason, number> = {
    manual: 0, new: 0, class: 0, hard: 0, linear: 0, relearn: 0,
  };
  for (const c of characters) counts[c.reason] += 1;
  return counts;
}

/** The 1,200-character 手写字表, across all three bands — recall's whole universe. */
export function handwritingChars(catalogue: HskCatalogue): Set<string> {
  return new Set(
    (['elementary', 'intermediate', 'advanced'] as const)
      .flatMap((band) => catalogue.handwriting(band))
      .map((c) => c.char),
  );
}

/** Chronological fail dates per character, so the date of the Nth lapse can be looked up. */
function lapseDates(reviews: readonly Review[]): Map<string, string[]> {
  const fails = new Map<string, string[]>();
  for (const r of reviews) {
    if (r.result !== 'fail') continue;
    const list = fails.get(r.char);
    if (list === undefined) fails.set(r.char, [r.date]);
    else list.push(r.date);
  }
  for (const dates of fails.values()) dates.sort();
  return fails;
}

/** The most recent date each character appeared on any sheet, drill or relearn alike. */
function lastDrilledDates(manifests: readonly SheetManifest[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const m of manifests) {
    for (const c of m.characters) {
      const seen = last.get(c.char);
      if (seen === undefined || m.date > seen) last.set(c.char, m.date);
    }
  }
  return last;
}

/**
 * Characters that have lapsed and are due to go back through drilling rather than just
 * being retested again — the join between recall and the drill sheet.
 *
 * This re-fires every time a character decays past the threshold, not just once in its
 * lifetime: the gate compares the character's most recent sheet appearance against the
 * date of its MOST RECENT lapse (not its first qualifying one). So: lapses, never drilled
 * since → selected. Gets drilled → not selected again tomorrow (the consecutive-day
 * guard). Lapses again after that → selected again. A character that decays, gets
 * retaught, and later decays again re-enters the rotation instead of being retaught once
 * and then left to fail forever.
 *
 * Returned most-lapsed first, because the caller has a bounded page and the
 * characters failing repeatedly are the ones reteaching is for. Ties break on code point,
 * never localeCompare: its collation follows the runtime's ICU data and default locale, so
 * a cap-bound tie could otherwise select a different set on the machine this is developed on
 * than on the one that generates the sheet each morning. Same reasoning as `dueItems`
 * in recall/pool.ts.
 */
function relearnCandidates(deps: GenerateDeps): string[] {
  if (deps.reviews === undefined) return [];

  const manifests = deps.sheets.allSheets();
  const reviews = deps.reviews.all();
  const schedules = replay(introducedDates(manifests, handwritingChars(deps.catalogue)), reviews);
  // Latest revisions only, the same view replay takes: a fail a re-grade corrected to a
  // pass is not a lapse, and must not re-select a character for a drill it never needed.
  const fails = lapseDates(latestRevisions(reviews));
  const lastDrilled = lastDrilledDates(manifests);

  return needsRelearning(schedules)
    .filter((char) => {
      const mostRecentLapse = fails.get(char)?.at(-1);
      // Defensive: needsRelearning already guarantees at least RELEARN_LAPSES fails exist.
      if (mostRecentLapse === undefined) return false;
      const drilled = lastDrilled.get(char);
      return drilled === undefined || drilled <= mostRecentLapse;
    })
    .sort(
      (a, b) =>
        (schedules.get(b)?.lapses ?? 0) - (schedules.get(a)?.lapses ?? 0) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
}

export async function planSheet(
  deps: GenerateDeps,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const date = options.date ?? isoDate(deps.now());
  const count = options.count ?? DEFAULT_COUNT;
  const doubleDownCount = options.doubleDownCount ?? DEFAULT_DOUBLE_DOWN;
  const warnings: string[] = [];

  // Re-running for a date must reproduce the same sheet, or a reprint would differ from
  // the page already on the device.
  const existing = deps.sheets.getSheet(date);
  if (existing !== null && options.force !== true) {
    return {
      date,
      characters: existing.characters,
      reused: true,
      counts: tally(existing.characters),
      warnings,
    };
  }

  const chosen: SheetCharacter[] = [];
  const taken = new Set<string>();

  const take = (char: string, reason: SelectionReason, sourceWord?: string): void => {
    if (taken.has(char) || chosen.length >= count) return;
    taken.add(char);
    chosen.push({ char, reason, ...(sourceWord === undefined ? {} : { sourceWord }) });
  };

  // 1. Manual pins. Explicitly requested, so they displace rather than append.
  const pinned = deps.queue.pending(date);
  for (const entry of pinned) take(entry.char, 'manual', entry.sourceWord);

  // 2. Relearn: a character that has lapsed twice needs reteaching, not just retesting.
  //    Placed with the same priority as manual pins — and through the same `take` path — so
  //    it cannot be silently crowded out by review or linear catch-up. Uncapped: at two
  //    lapses these are rare enough not to crowd out the day's new characters, and the ones
  //    that do reach it have earned the row.
  for (const char of relearnCandidates(deps)) take(char, 'relearn');

  // 3. Double-down review. A missing or unreachable Anki degrades to linear-only rather
  //    than failing the whole morning.
  if (deps.vocab !== undefined && doubleDownCount > 0 && chosen.length < count) {
    try {
      const classDate = await deps.vocab.latestClassDate();
      const [classWords, yesterdayWords, hardWords] = await Promise.all([
        classDate === null ? Promise.resolve([]) : deps.vocab.classWords(classDate),
        deps.vocab.wordsIntroducedDaysAgo(1),
        deps.vocab.hardestWords(doubleDownCount * 2),
      ]);

      const want = Math.min(doubleDownCount, count - chosen.length);
      const review = selectDoubleDown(
        { yesterdayWords, classWords, hardWords },
        { count: want, skip: deps.skip, exclude: taken },
      );
      for (const c of review) take(c.char, c.reason, c.sourceWord);
    } catch (e) {
      warnings.push(
        `Could not read review vocabulary from Anki, so this sheet is linear only. ${(e as Error).message}`,
      );
    }
  }

  // 4. Linear catch-up fills the rest.
  if (chosen.length < count) {
    const sequence = buildLinearSequence(deps.catalogue, {
      skip: deps.skip,
      ...(options.includeAnkiExtras === undefined
        ? {}
        : { includeAnkiExtras: options.includeAnkiExtras }),
    });
    // Already-chosen characters count as done for this pass, so nothing repeats.
    // Excluding this date: a forced rebuild must not treat the sheet's own previous
    // characters as done, or it silently skips forward instead of reproducing them.
    const done = new Set([...deps.sheets.linearDone(date), ...taken]);
    for (const entry of selectLinear(sequence, { done, count: count - chosen.length })) {
      take(entry.char, 'linear');
    }
  }

  if (chosen.length < count) {
    warnings.push(
      `Only ${chosen.length} of ${count} characters available — linear catch-up has run out. ` +
        'Add more via the queue, or enable Anki extras.',
    );
  }

  deps.sheets.saveSheet({ date, characters: chosen });
  deps.queue.consume(
    chosen.filter((c) => c.reason === 'manual').map((c) => c.char),
    date,
  );

  return { date, characters: chosen, reused: false, counts: tally(chosen), warnings };
}

/**
 * What to test from memory today.
 *
 * Recall draws only on the handwriting list, and only on characters a drill sheet has
 * already taught. It never touches the drill budget: the two halves of the sheet are
 * scheduled independently, because copying a character and recalling it are different
 * skills with different histories.
 */
export async function planRecall(
  deps: GenerateDeps,
  options: { date?: string; capacity: number },
): Promise<RecallSelection[]> {
  if (deps.reviews === undefined) return [];

  const date = options.date ?? isoDate(deps.now());
  const schedules = replay(
    introducedDates(deps.sheets.allSheets(), handwritingChars(deps.catalogue)),
    deps.reviews.all(),
  );

  return dueItems(schedules, date, options.capacity)
    .map((s) => ({ char: s.char, due: s.due, lapses: s.lapses }));
}
