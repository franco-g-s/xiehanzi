import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSheet, planRecall, DEFAULT_COUNT, DEFAULT_DOUBLE_DOWN } from './generate.js';
import type { GenerateDeps } from './generate.js';
import { createQueueStore } from './state/queue.js';
import { createSheetStore } from './state/sheets.js';
import { createReviewStore } from './state/reviews.js';
import { createCatalogue, parseCharList, parseFrequency } from './sources/hsk.js';
import type { Review } from './recall/schedule.js';

// 6 handwriting characters, frequency-ordered: 一 二 三 四 五 六
const CHARS = `一级汉字表
1\t一
2\t二
3\t三
4\t四
5\t五
6\t六
初等手写字表
1\t一
2\t二
3\t三
4\t四
5\t五
6\t六
`;
const FREQ = '1\t一\n2\t二\n3\t三\n4\t四\n5\t五\n6\t六\n';
const catalogue = createCatalogue(parseCharList(CHARS), parseFrequency(FREQ));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xiehanzi-gen-'));
});

function deps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    catalogue,
    queue: createQueueStore(join(dir, 'queue.json'), { now: () => new Date('2026-08-20T06:00:00Z') }),
    sheets: createSheetStore(join(dir, 'sheets.json'), { now: () => new Date('2026-08-20T06:00:00Z') }),
    vocab: {
      latestClassDate: async () => '2026-08-17',
      classWords: async () => ['笔试'],
      wordsIntroducedDaysAgo: async () => ['塑料'],
      hardestWords: async () => [{ word: '成绩', lapses: 8 }],
    },
    skip: [],
    now: () => new Date('2026-08-20T06:00:00Z'),
    ...over,
  };
}

const chars = (r: { characters: { char: string }[] }) => r.characters.map((c) => c.char).join('');

describe('planSheet', () => {
  it('fills the sheet to the requested size', async () => {
    const r = await planSheet(deps(), { count: 6, doubleDownCount: 0 });
    expect(r.characters).toHaveLength(6);
  });

  it('walks linear in frequency order when nothing else applies', async () => {
    const r = await planSheet(deps(), { count: 3, doubleDownCount: 0 });
    expect(chars(r)).toBe('一二三');
  });

  it('resumes where the previous sheet left off', async () => {
    const d = deps();
    await planSheet(d, { date: '2026-08-19', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    expect(chars(r)).toBe('四五六');
  });

  it('puts manual pins first and counts them against the total', async () => {
    const d = deps();
    d.queue.add(['五'], { date: '2026-08-20' });
    const r = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    expect(chars(r)).toBe('五一二');
    expect(r.characters[0]!.reason).toBe('manual');
  });

  it('never repeats a character within one sheet', async () => {
    const d = deps();
    d.queue.add(['一'], { date: '2026-08-20' });
    const r = await planSheet(d, { date: '2026-08-20', count: 4, doubleDownCount: 0 });
    expect(new Set(chars(r)).size).toBe(4);
  });

  it('marks pinned characters consumed so they do not come back', async () => {
    const d = deps();
    d.queue.add(['五'], { date: '2026-08-20' });
    await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    expect(d.queue.pending('2026-08-20')).toEqual([]);
  });

  it('mixes double-down review in with the linear characters', async () => {
    const r = await planSheet(deps(), { count: 6, doubleDownCount: 3 });
    const reasons = new Set(r.characters.map((c) => c.reason));
    expect(reasons.has('linear')).toBe(true);
    expect([...reasons].some((x) => x === 'new' || x === 'class' || x === 'hard')).toBe(true);
  });

  it('reports how many came from each source', async () => {
    const r = await planSheet(deps(), { count: 6, doubleDownCount: 2 });
    const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });
});

describe('planSheet — idempotency', () => {
  it('returns the identical sheet when run twice for the same date', async () => {
    const d = deps();
    const first = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    const second = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    expect(chars(second)).toBe(chars(first));
    expect(second.reused).toBe(true);
  });

  it('does not advance linear progress on a re-run', async () => {
    const d = deps();
    await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    expect(d.sheets.linearDone()).toHaveLength(3);
  });

  it('regenerates from scratch with force', async () => {
    const d = deps();
    await planSheet(d, { date: '2026-08-20', count: 2, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-20', count: 2, doubleDownCount: 0, force: true });
    expect(r.reused).toBe(false);
  });
});

describe('planSheet — degrading gracefully', () => {
  // The morning job must still produce a sheet if Anki is closed or the server is offline.
  it('falls back to linear only when Anki cannot be reached', async () => {
    const d = deps({
      vocab: {
        latestClassDate: async () => { throw new Error('Could not reach Anki at 127.0.0.1:8765'); },
        classWords: async () => [],
        wordsIntroducedDaysAgo: async () => [],
        hardestWords: async () => [],
      },
    });
    const r = await planSheet(d, { count: 4, doubleDownCount: 2 });

    expect(r.characters).toHaveLength(4);
    expect(r.characters.every((c) => c.reason === 'linear')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/anki/i);
  });

  it('works with no Anki configured at all', async () => {
    const d = deps();
    delete (d as { vocab?: unknown }).vocab;
    const r = await planSheet(d, { count: 3, doubleDownCount: 2 });
    expect(r.characters).toHaveLength(3);
  });

  it('warns rather than failing when linear runs out of characters', async () => {
    const r = await planSheet(deps(), { count: 50, doubleDownCount: 0 });
    expect(r.characters.length).toBeLessThan(50);
    expect(r.warnings.join(' ')).toMatch(/run out|exhausted/i);
  });

  it('skips skip-list characters entirely', async () => {
    const r = await planSheet(deps({ skip: ['一', '二'] }), { count: 2, doubleDownCount: 0 });
    expect(chars(r)).toBe('三四');
  });
});

describe('planSheet — force rebuilds faithfully', () => {
  it('reproduces the same characters when forced, not the next ones along', async () => {
    const d = deps();
    const first = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0 });
    const forced = await planSheet(d, { date: '2026-08-20', count: 3, doubleDownCount: 0, force: true });

    expect(chars(forced)).toBe(chars(first));
  });

  it('still resumes correctly on the following day after a forced rebuild', async () => {
    const d = deps();
    await planSheet(d, { date: '2026-08-20', count: 2, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-20', count: 2, doubleDownCount: 0, force: true });
    const next = await planSheet(d, { date: '2026-08-21', count: 2, doubleDownCount: 0 });

    expect(chars(next)).toBe('三四');
  });
});

/** A deps() with a review store attached, plus whatever reviews the test needs. */
function recallDeps(reviews: Review[] = [], over: Partial<GenerateDeps> = {}) {
  const store = createReviewStore(join(dir, 'reviews.json'));
  if (reviews.length > 0) store.append(reviews);
  return deps({ reviews: store, ...over });
}

const fail = (date: string, char: string): Review =>
  ({ date, char, result: 'fail', evidence: 'ink' });

describe('planRecall', () => {
  it('selects nothing when no character has ever been drilled', async () => {
    expect(await planRecall(recallDeps(), { date: '2026-08-22', capacity: 10 })).toEqual([]);
  });

  it('offers a character drilled yesterday for recall today', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const recall = await planRecall(d, { date: '2026-08-22', capacity: 10 });
    // All three share a due date, so dueItems' tie-break (localeCompare on the character,
    // not insertion order) decides the order here — 一 三 二, not the sheet's own order.
    expect(recall.map((r) => r.char)).toEqual(['一', '三', '二']);
  });

  it('does not offer a character drilled today — it is not due until tomorrow', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-22', count: 3, doubleDownCount: 0 });
    expect(await planRecall(d, { date: '2026-08-22', capacity: 10 })).toEqual([]);
  });

  it('stops at capacity, leaving the rest due', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });
    const recall = await planRecall(d, { date: '2026-08-22', capacity: 2 });
    expect(recall).toHaveLength(2);
  });

  it('respects a passed review by not asking again the next day', async () => {
    const d = recallDeps([{ date: '2026-08-22', char: '一', result: 'pass', evidence: 'ink' }]);
    await planSheet(d, { date: '2026-08-21', count: 1, doubleDownCount: 0 });
    // Passing the first step pushes 一 out three days.
    expect(await planRecall(d, { date: '2026-08-23', capacity: 10 })).toEqual([]);
  });

  it('carries an unattempted item forward rather than dropping it', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-21', count: 1, doubleDownCount: 0 });
    // Nothing was recorded on the 22nd, so it is still due — and more overdue — on the 23rd.
    expect((await planRecall(d, { date: '2026-08-23', capacity: 10 })).map((r) => r.char))
      .toEqual(['一']);
  });

  it('puts the most overdue item first', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-19', count: 1, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-21', count: 2, doubleDownCount: 0 });
    expect((await planRecall(d, { date: '2026-08-23', capacity: 10 }))[0]!.char).toBe('一');
  });

  it('returns nothing when there is no review store at all', async () => {
    // Recall is additive: a caller that has not adopted it still generates drill sheets.
    const d = deps();
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    expect(await planRecall(d, { date: '2026-08-22', capacity: 10 })).toEqual([]);
  });
});

describe('planSheet with recall in play', () => {
  it('does not let recall consume the drill budget', async () => {
    const d = recallDeps();
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-22', count: 3, doubleDownCount: 0 });
    expect(r.characters).toHaveLength(3);
    expect(chars(r)).toBe('四五六');
  });

  it('re-drills a character that has lapsed twice', async () => {
    const d = recallDeps([fail('2026-08-22', '一'), fail('2026-08-23', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-24', count: 3, doubleDownCount: 0 });
    expect(chars(r)).toContain('一');
    expect(r.characters.find((c) => c.char === '一')!.reason).toBe('relearn');
  });

  // One lapse is enough. Measured retention against the gap between a character being
  // drilled and first recalled: 75% passed at 3 days, 42% at 4, 25% at 5. Holding a missed
  // character back for a second lapse before reteaching it just added another cycle of that
  // decay, so a character missed yesterday goes straight back onto today's drill page.
  it('re-drills a character after two lapses', async () => {
    const d = recallDeps([fail('2026-08-22', '一'), fail('2026-08-23', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-24', count: 3, doubleDownCount: 0 });
    expect(chars(r)).toContain('一');
    expect(r.characters.find((c) => c.char === '一')!.reason).toBe('relearn');
  });

  // One miss belongs to the recall pages, which hold ~22 slots a day; spending a drill row
  // on it would take the slot from a new character for something recall catches anyway.
  it('leaves a character missed only once to the recall page', async () => {
    const d = recallDeps([fail('2026-08-22', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-23', count: 3, doubleDownCount: 0 });
    expect(chars(r)).not.toContain('一');
  });

  it('leaves a character that has never been missed to the linear march', async () => {
    const d = recallDeps([{ date: '2026-08-22', char: '一', result: 'pass' as const, evidence: 'ink' as const }]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    const r = await planSheet(d, { date: '2026-08-23', count: 3, doubleDownCount: 0 });
    expect(chars(r)).not.toContain('一');
  });

  it('does not re-drill the same character on consecutive days', async () => {
    // Relearn puts it back on a drill sheet once; the recall schedule takes it from there.
    const d = recallDeps([fail('2026-08-22', '一'), fail('2026-08-23', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-24', count: 3, doubleDownCount: 0 });
    const second = await planSheet(d, { date: '2026-08-25', count: 3, doubleDownCount: 0 });
    expect(chars(second)).not.toContain('一');
  });

  it('re-fires when a re-drilled character lapses again later', async () => {
    // Relearn must key off the MOST RECENT lapse, not the first one that crossed the
    // threshold — otherwise a character retaught once is never retaught again, no matter
    // how many more times it decays.
    const d = recallDeps([fail('2026-08-22', '一'), fail('2026-08-23', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-24', count: 3, doubleDownCount: 0 }); // relearn drills 一
    d.reviews!.append([fail('2026-08-26', '一')]); // 一 decays again after being retaught
    const r = await planSheet(d, { date: '2026-08-27', count: 3, doubleDownCount: 0 });
    expect(chars(r)).toContain('一');
    expect(r.characters.find((c) => c.char === '一')!.reason).toBe('relearn');
  });

  // A re-grade corrects a fail by appending a pass one revision higher. The corrected fail
  // must stop counting as a lapse, or it re-selects a character for a drill it never needed.
  it('ignores a lapse that a later revision corrected to a pass', async () => {
    const d = recallDeps([fail('2026-08-22', '一'), fail('2026-08-23', '一')]);
    await planSheet(d, { date: '2026-08-21', count: 3, doubleDownCount: 0 });
    await planSheet(d, { date: '2026-08-24', count: 3, doubleDownCount: 0 }); // relearn drills 一
    d.reviews!.append([
      fail('2026-08-26', '一'),
      { date: '2026-08-26', char: '一', result: 'pass' as const, evidence: 'recognition' as const, revision: 1 },
    ]);
    const r = await planSheet(d, { date: '2026-08-27', count: 3, doubleDownCount: 0 });
    expect(r.characters.find((c) => c.char === '一')?.reason).not.toBe('relearn');
  });
});

describe('the daily workload', () => {
  // Four days of real data: recall pass rates fell 70% → 70% → 50% → 10%, and 92 of 132
  // drilled characters had never been tested even once. The cause was arithmetic, not
  // difficulty — 18 new characters a day against a recall capacity of 10 grows the queue by
  // ~8 a day, so a character's first recall test landed 3-5 days after it was drilled
  // instead of 1. Retention by that lag: 75% at 3 days, 42% at 4, 25% at 5. Nine a day is
  // one drill page, and sits under the ~20 recall slots two recall pages provide, so the
  // backlog drains instead of growing.
  it('drills one page a day', () => {
    expect(DEFAULT_COUNT).toBe(9);
  });

  // Anki is opt-in now (`--review=N`), not the default. A normal morning is linear-only and
  // never reaches for the network.
  it('pulls no review vocabulary by default', () => {
    expect(DEFAULT_DOUBLE_DOWN).toBe(0);
  });

  it('never touches the vocabulary source when nothing is asked of it', async () => {
    const touched: string[] = [];
    const trap = (name: string) => async (): Promise<never> => {
      touched.push(name);
      throw new Error('Could not reach Anki at 127.0.0.1:8765');
    };
    const d = deps({
      vocab: {
        latestClassDate: trap('latestClassDate'),
        classWords: trap('classWords'),
        wordsIntroducedDaysAgo: trap('wordsIntroducedDaysAgo'),
        hardestWords: trap('hardestWords'),
      },
    });

    const r = await planSheet(d, { count: 3, doubleDownCount: 0 });

    expect(touched).toEqual([]);
    // Nothing was asked of Anki, so there is nothing to warn about — a warning here would
    // report a failure that never happened, every single morning.
    expect(r.warnings.join(' ')).not.toMatch(/anki/i);
    expect(r.characters.every((c) => c.reason === 'linear')).toBe(true);
  });
});

describe('planSheet — relearn takes two lapses', () => {
  /** Fails `char` `n` times on consecutive days from 2026-08-22, so lapses = n. */
  const fails = (char: string, n: number) =>
    Array.from({ length: n }, (_, i) => fail(`2026-08-${22 + i}`, char));

  // A single miss is left to the recall pages, which now hold ~22 slots a day against an
  // intake of 9 — a lapse already shortens the interval, so it comes back within a day or
  // two without spending a drill row on it.
  it('leaves a character missed once to the recall page', async () => {
    const d = recallDeps([...fails('一', 1), ...fails('二', 1)]);
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });

    const r = await planSheet(d, { date: '2026-08-30', count: 6, doubleDownCount: 0 });
    expect(r.counts.relearn).toBe(0);
  });

  it('re-drills a character that has lapsed twice', async () => {
    const d = recallDeps([...fails('一', 1), ...fails('四', 2), ...fails('五', 2)]);
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });

    const r = await planSheet(d, { date: '2026-08-30', count: 6, doubleDownCount: 0 });
    expect(r.counts.relearn).toBe(2);
    expect(chars(r)).toContain('四');
    expect(chars(r)).toContain('五');
    expect(chars(r)).not.toContain('一');
  });

  it('does not cap relearn — two lapses is rare enough to earn every row it takes', async () => {
    const d = recallDeps([
      ...fails('一', 2), ...fails('二', 2), ...fails('三', 2),
      ...fails('四', 2), ...fails('五', 2), ...fails('六', 2),
    ]);
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });

    const r = await planSheet(d, { date: '2026-08-30', count: 6, doubleDownCount: 0 });
    expect(r.counts.relearn).toBe(6);
  });

  it('takes the most-lapsed characters first', async () => {
    const d = recallDeps([
      ...fails('一', 1), ...fails('二', 2), ...fails('三', 2),
      ...fails('四', 2), ...fails('五', 2), ...fails('六', 3),
    ]);
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });

    const r = await planSheet(d, { date: '2026-08-30', count: 6, doubleDownCount: 0 });
    const relearn = r.characters.filter((c) => c.reason === 'relearn').map((c) => c.char);
    // 六 (3 lapses) first, then the four with 2 each in code-point order: 三 U+4E09,
    // 五 U+4E94, 四 U+56DB, 二 U+4E8C. 一 has only one lapse and is not a candidate.
    expect(relearn[0]).toBe('六');
    expect(relearn).not.toContain('一');
    expect(relearn.slice(1).sort()).toEqual(['三', '二', '五', '四'].sort());
  });

  it('breaks a tie by code point, not by locale collation', async () => {
    // Same reason dueItems does: localeCompare follows the runtime's ICU data and default
    // locale, so a page-bound tie could order differently on one machine than on another
    // that actually generates the sheet.
    const d = recallDeps([...fails('二', 2), ...fails('三', 2), ...fails('一', 2)]);
    await planSheet(d, { date: '2026-08-21', count: 6, doubleDownCount: 0 });

    const r = await planSheet(d, { date: '2026-08-30', count: 3, doubleDownCount: 0 });
    expect(r.characters.filter((c) => c.reason === 'relearn').map((c) => c.char))
      .toEqual(['一', '三', '二']);
  });
});
