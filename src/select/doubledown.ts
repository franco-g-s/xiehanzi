/**
 * Double-down review: drill what you are actually struggling with right now.
 *
 * Three sources, in priority order — yesterday's new vocabulary, the most recent class,
 * and the cards Anki says you keep failing. Pure: fetching the inputs is someone else's
 * job, so this is fully testable without Anki or any notes.
 */

import { decompose, type DecomposedChar } from './decompose.js';

export type HardWord = { word: string; lapses: number };

export type DoubleDownInput = {
  /** Words whose cards were first studied yesterday. */
  yesterdayWords: readonly string[];
  /** Vocabulary from the most recent class note. */
  classWords: readonly string[];
  /** Current vocabulary with lapse counts; ordering is done here. */
  hardWords: readonly HardWord[];
};

export type SelectionReason = 'new' | 'class' | 'hard';

export type DoubleDownChar = DecomposedChar & { reason: SelectionReason };

export type Quota = { new: number; class: number; hard: number };

export type DoubleDownOptions = {
  count: number;
  skip?: Iterable<string>;
  /** Characters already on the sheet — manual pins, typically. */
  exclude?: Iterable<string>;
  /**
   * Target characters per source. Any shortfall is redistributed to the others, so a
   * quiet week still fills the sheet instead of leaving it half empty.
   */
  quota?: Quota;
};

export function selectDoubleDown(
  input: DoubleDownInput,
  options: DoubleDownOptions,
): DoubleDownChar[] {
  const skip = new Set(options.skip ?? []);
  const taken = new Set(options.exclude ?? []);

  // Hardest first. Ties keep their original order, so the result stays deterministic.
  const hardestFirst = [...input.hardWords]
    .sort((a, b) => b.lapses - a.lapses)
    .map((h) => h.word);

  const pools: ReadonlyArray<{ reason: SelectionReason; chars: DecomposedChar[] }> = [
    { reason: 'new', chars: decompose(input.yesterdayWords, { skip }) },
    { reason: 'class', chars: decompose(input.classWords, { skip }) },
    { reason: 'hard', chars: decompose(hardestFirst, { skip }) },
  ];

  const out: DoubleDownChar[] = [];
  const cursors = new Map<SelectionReason, number>(pools.map((p) => [p.reason, 0]));

  /** Takes up to `want` unused characters from one pool. */
  const drawFrom = (pool: (typeof pools)[number], want: number): number => {
    let drawn = 0;
    let i = cursors.get(pool.reason)!;
    while (drawn < want && i < pool.chars.length && out.length < options.count) {
      const entry = pool.chars[i]!;
      i += 1;
      if (taken.has(entry.char)) continue;
      taken.add(entry.char);
      out.push({ ...entry, reason: pool.reason });
      drawn += 1;
    }
    cursors.set(pool.reason, i);
    return drawn;
  };

  const quota = options.quota;
  if (quota !== undefined) {
    for (const pool of pools) drawFrom(pool, quota[pool.reason]);
  }

  // Fill whatever remains — either the whole sheet when no quota was given, or the
  // shortfall left by sources that had nothing to offer.
  for (const pool of pools) {
    if (out.length >= options.count) break;
    drawFrom(pool, options.count - out.length);
  }

  return out;
}
