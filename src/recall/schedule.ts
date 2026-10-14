/**
 * SM-2 over writing recall, replayed from the review log rather than stored.
 *
 * Nothing here reads the clock or the filesystem: the caller supplies the dates. That is
 * what lets a year of scheduling behaviour be tested in milliseconds, and it is why the
 * schedule can never drift from the reviews that produced it.
 *
 * Not FSRS — that needs a trained model and a review history which does not exist yet.
 * The point of SM-2 here is that for any item due today you can say in one sentence why.
 */

export type ReviewResult = 'pass' | 'fail';

/**
 * `transcription` and `ink` are the original evidence kinds: the device's own transcription,
 * and ink presence. `ink` survives only for a blank graded cell in a row that was otherwise
 * written on. `recognition` is a verdict from the stroke and vision recognisers.
 * `confusion` is the fail recorded against a character Franco wrote *instead of* the one
 * asked.
 */
export type ReviewEvidence = 'transcription' | 'ink' | 'recognition' | 'confusion';

export type Review = {
  date: string;
  char: string;
  result: ReviewResult;
  evidence: ReviewEvidence;
  /** What was written, as the deciding recogniser(s) read it. Absent for ink verdicts. */
  read?: string;
  /** Recognisers that produced the verdict, e.g. ['google', 'go:grok-4.6']. */
  sources?: string[];
  /** Confusion only: the character the cell was asking for. */
  asked?: string;
  /** Graded without every recogniser the partner mode needs; the nightly run re-grades the date. */
  degraded?: boolean;
  /**
   * Absent means 0. Re-grading a date appends a complete new set of that date's verdicts
   * one revision higher. Replay reads only the highest, so a correction replaces what it
   * corrects without anything being deleted.
   */
  revision?: number;
};

export type Schedule = {
  char: string;
  due: string;
  intervalDays: number;
  ease: number;
  step: number | null;
  reps: number;
  lapses: number;
};

/** Days. A character is asked again tomorrow, then three days later, then on its own ease. */
export const LEARNING_STEPS = [1, 3] as const;

export const EASE_START = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 2.8;
const EASE_UP = 0.1;
const EASE_DOWN = 0.2;

// Ease compounds every graduated pass with no natural ceiling — an item reviewed daily
// (ignoring its own due date, as a bulk import or a stress test might) doubles its interval
// every few reviews and overflows `Date`'s usable range within a few dozen passes. Ten years
// is far past any interval a daily practice sheet would ever actually reach.
export const MAX_INTERVAL_DAYS = 3650;

const DAY_MS = 86_400_000;

/** UTC throughout: a local-time date would shift by one across a DST boundary. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

function fresh(char: string, introduced: string): Schedule {
  return {
    char,
    due: addDays(introduced, LEARNING_STEPS[0]),
    intervalDays: LEARNING_STEPS[0],
    ease: EASE_START,
    step: 0,
    reps: 0,
    lapses: 0,
  };
}

function pass(s: Schedule, date: string): Schedule {
  const reps = s.reps + 1;

  if (s.step !== null) {
    const next = s.step + 1;
    if (next < LEARNING_STEPS.length) {
      const interval = LEARNING_STEPS[next]!;
      return { ...s, step: next, intervalDays: interval, due: addDays(date, interval), reps };
    }
    // Graduating is literally "then interval x ease" applied to the last step.
    const interval = Math.round(LEARNING_STEPS[LEARNING_STEPS.length - 1]! * s.ease);
    return { ...s, step: null, intervalDays: interval, due: addDays(date, interval), reps };
  }

  // Ease applies at its current value, then rises — the Anki ordering, so an item's first
  // graduated interval is not already inflated by the review that produced it.
  const interval = Math.min(MAX_INTERVAL_DAYS, Math.max(s.intervalDays + 1, Math.round(s.intervalDays * s.ease)));
  return {
    ...s,
    intervalDays: interval,
    due: addDays(date, interval),
    ease: Math.min(EASE_MAX, s.ease + EASE_UP),
    reps,
  };
}

function fail(s: Schedule, date: string): Schedule {
  // Ease moves only for graduated items, in both directions. The learning steps are the
  // two easiest reviews an item will ever get; neither passing nor failing them says
  // enough about long-term difficulty to be worth recording in the ease.
  const ease = s.step === null ? Math.max(EASE_MIN, s.ease - EASE_DOWN) : s.ease;
  const interval = LEARNING_STEPS[0]!;
  return {
    ...s,
    step: 0,
    intervalDays: interval,
    due: addDays(date, interval),
    ease,
    reps: s.reps + 1,
    lapses: s.lapses + 1,
  };
}

/** Only the highest revision of each date's verdicts. */
export function latestRevisions(reviews: readonly Review[]): Review[] {
  const highest = new Map<string, number>();
  for (const r of reviews) {
    const rev = r.revision ?? 0;
    if (rev > (highest.get(r.date) ?? -1)) highest.set(r.date, rev);
  }
  return reviews.filter((r) => (r.revision ?? 0) === highest.get(r.date));
}

export function replay(
  introduced: ReadonlyMap<string, string>,
  reviews: readonly Review[],
): Map<string, Schedule> {
  const schedules = new Map<string, Schedule>();
  for (const [char, date] of introduced) schedules.set(char, fresh(char, date));

  // Sorted rather than trusted: the log is append-only, but a repaired or merged file has
  // no such guarantee, and out-of-order replay would silently produce a different schedule.
  //
  // The comparator goes past `date` on purpose. Two reviews can share a date — a
  // transcription verdict and an ink verdict both landing on one character on one day is a
  // real case, not a hypothetical one — and JS's stable sort would then fall back to
  // whatever order the caller happened to pass them in. That makes the result depend on
  // array position, which is exactly the "drifted schedule" this function exists to avoid.
  // Ordering by every field of the record instead makes the comparator total: two reviews
  // identical in every field are genuinely interchangeable, so the result depends only on
  // the multiset of reviews in the log, never on how they were stored or merged.
  const ordered = latestRevisions(reviews).sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.char.localeCompare(b.char) ||
    a.evidence.localeCompare(b.evidence) ||
    a.result.localeCompare(b.result) ||
    (a.read ?? '').localeCompare(b.read ?? ''),
  );

  for (const r of ordered) {
    const current = schedules.get(r.char);
    // A review for something never drilled is not an error — it is a character dropped
    // from the handwriting list, or a manifest edited by hand. Ignore it rather than
    // inventing a schedule for a character that will never be selected again.
    if (current === undefined) continue;
    schedules.set(r.char, r.result === 'pass' ? pass(current, r.date) : fail(current, r.date));
  }

  return schedules;
}
