/**
 * Linear catch-up: a graded march through the HSK 3.0 characters.
 *
 * Order follows the standard's own priority. The 1,200 characters HSK requires you to
 * write by hand come first, band by band (初等 → 中等 → 高等), then the 1,800 it only asks
 * you to recognise. Within each band, most frequent first.
 *
 * Position is tracked as a set of characters already done, NOT an index. An index would
 * silently point somewhere else the moment the skip list or the extras setting changed
 * the sequence — and you would not notice until the sheets looked wrong.
 */

import type { HskCatalogue, HskChar, HandwritingBand } from '../sources/hsk.js';

const BANDS: readonly HandwritingBand[] = ['elementary', 'intermediate', 'advanced'];

export type LinearOptions = {
  /** Characters too trivial to spend a row on. */
  skip?: Iterable<string>;
  /** Characters from Anki words that aren't in the HSK list at all. */
  ankiExtras?: readonly string[];
  /** Off by default: the graded HSK progression is the point. */
  includeAnkiExtras?: boolean;
  /** `handwriting` stops after the 1,200; `all` continues into recognition-only. */
  phase?: 'handwriting' | 'all';
  /** Frequency ranks, needed to place extras. Defaults to the catalogue's own. */
  frequency?: ReadonlyMap<string, number>;
};

/** Unranked characters sort last rather than first. */
const rankOf = (c: HskChar): number => c.frequencyRank ?? Number.MAX_SAFE_INTEGER;

const byFrequency = (a: HskChar, b: HskChar): number => rankOf(a) - rankOf(b);

const byLevelThenFrequency = (a: HskChar, b: HskChar): number =>
  a.readingLevel - b.readingLevel || rankOf(a) - rankOf(b);

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.MAX_SAFE_INTEGER;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Which band an Anki extra belongs in, judged by frequency.
 *
 * Boundaries are the bands' own median ranks, computed from the data rather than
 * hardcoded. Band *ceilings* would not work: they overlap badly (初等 reaches rank 1972
 * while 中等 reaches 3650), so nearly every extra would land in the first band.
 */
function placeExtra(rank: number, medians: ReadonlyMap<HandwritingBand, number>): HandwritingBand | null {
  for (const band of BANDS) {
    if (rank <= (medians.get(band) ?? Number.MAX_SAFE_INTEGER)) return band;
  }
  return null;
}

export function buildLinearSequence(
  catalogue: HskCatalogue,
  options: LinearOptions = {},
): HskChar[] {
  const skip = new Set(options.skip ?? []);
  const phase = options.phase ?? 'all';

  const bandMembers = new Map(BANDS.map((b) => [b, [...catalogue.handwriting(b)]]));
  const readingOnly = [...catalogue.readingOnly()];

  if (options.includeAnkiExtras === true && options.ankiExtras !== undefined) {
    const medians = new Map(
      BANDS.map((b) => [b, median(bandMembers.get(b)!.map(rankOf))] as const),
    );
    const frequency = options.frequency;

    for (const char of options.ankiExtras) {
      // Already graded by the standard — nothing to interleave.
      if (catalogue.get(char) !== undefined) continue;

      const rank = frequency?.get(char) ?? Number.MAX_SAFE_INTEGER;
      const band = placeExtra(rank, medians);
      const entry: HskChar = {
        char,
        // No HSK level of its own; sorts with the last reading group.
        readingLevel: 7,
        handwritingBand: band,
        frequencyRank: rank === Number.MAX_SAFE_INTEGER ? null : rank,
      };
      if (band === null) readingOnly.push(entry);
      else bandMembers.get(band)!.push(entry);
    }
  }

  const sequence: HskChar[] = [];
  for (const band of BANDS) sequence.push(...bandMembers.get(band)!.sort(byFrequency));
  if (phase === 'all') sequence.push(...readingOnly.sort(byLevelThenFrequency));

  return sequence.filter((c) => !skip.has(c.char));
}

export type SelectLinearOptions = {
  /** Characters already practised in linear mode. */
  done: Iterable<string>;
  count: number;
};

/** The next `count` characters not yet done. Pure — advancing state is the caller's job. */
export function selectLinear(
  sequence: readonly HskChar[],
  options: SelectLinearOptions,
): HskChar[] {
  const done = new Set(options.done);
  const out: HskChar[] = [];
  for (const entry of sequence) {
    if (done.has(entry.char)) continue;
    out.push(entry);
    if (out.length === options.count) break;
  }
  return out;
}
