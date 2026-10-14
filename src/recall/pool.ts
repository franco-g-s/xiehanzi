/**
 * Who is eligible for recall, and who is asked today.
 *
 * Two conditions make a character eligible: it has appeared on a drill sheet, which is the
 * only evidence it was ever taught, and it is in the 1,200-character 手写字表.
 *
 * The second is a membership test, not a test of why the character was selected — 城 came
 * from class vocabulary but is a handwriting character, so it is in. Reading-only
 * characters are excluded because asking for a character the standard never asks you to
 * write manufactures failures that mean nothing.
 */

import type { SheetManifest } from '../state/sheets.js';
import type { Schedule } from './schedule.js';

export function introducedDates(
  manifests: readonly SheetManifest[],
  handwriting: ReadonlySet<string>,
): Map<string, string> {
  const first = new Map<string, string>();

  for (const manifest of manifests) {
    for (const { char } of manifest.characters) {
      if (!handwriting.has(char)) continue;
      const existing = first.get(char);
      // Earliest wins. Manifests are not guaranteed sorted, and a later date would
      // postpone the first review of a character taught weeks ago.
      if (existing === undefined || manifest.date < existing) first.set(char, manifest.date);
    }
  }

  return first;
}

/**
 * The schedule decides which items; the caller's capacity decides how many.
 *
 * Splitting the decision is what keeps the morning a predictable length while still
 * letting the algorithm choose. Overflow is not dropped — it stays due, and sorts to the
 * front tomorrow.
 */
export function dueItems(
  schedules: ReadonlyMap<string, Schedule>,
  today: string,
  capacity: number,
): Schedule[] {
  return [...schedules.values()]
    .filter((s) => s.due <= today)
    // Tie-break on char rather than leaving equally-overdue items in Map insertion order,
    // which depends on manifest order and would make the result nondeterministic. A plain
    // code-point comparison, not localeCompare: localeCompare's collation follows the
    // runtime's ICU data and default locale, which can differ between the machine this is
    // developed on and another that actually generates the sheet — the exact same
    // capacity-bound tie could silently pick a different subset of due items on each
    // machine. `due` is an ISO date string, where localeCompare and code-point order
    // agree, so only the char comparison needed to change.
    .sort((a, b) => a.due.localeCompare(b.due) || (a.char < b.char ? -1 : a.char > b.char ? 1 : 0))
    .slice(0, Math.max(0, capacity));
}

/**
 * Two lapses, not one, before a character is re-taught rather than merely re-tested.
 *
 * This briefly ran at 1, when recall had a single page and a missed character had nowhere
 * to go but the drill page. With two recall pages there are ~22 slots a day against an
 * intake of 9, so a miss comes back on the recall page within a day or two under its own
 * schedule — the shortened interval a lapse already produces. Re-drilling on the first
 * miss now spends a drill slot on something recall would have caught anyway, and drill
 * slots are what the HSK march runs on.
 *
 * Two lapses still means genuinely stuck: the character failed, came back early, and
 * failed again. That is the signal worth spending a drill row on.
 */
export const RELEARN_LAPSES = 2;

/**
 * The join between the two halves of the system: recall finds what decayed, drilling
 * repairs it. Without this a forgotten character is retested at shortening intervals
 * forever and never retaught.
 */
export function needsRelearning(schedules: ReadonlyMap<string, Schedule>): string[] {
  return [...schedules.values()]
    .filter((s) => s.lapses >= RELEARN_LAPSES)
    .map((s) => s.char)
    .sort();
}
