import { describe, it, expect } from 'vitest';
import { selectDoubleDown } from './doubledown.js';
import type { DoubleDownInput } from './doubledown.js';

const input: DoubleDownInput = {
  yesterdayWords: ['塑料', '橡皮'],
  classWords: ['friendship友谊', '关怀'].map((w) => w.replace(/[a-z]/gi, '')),
  hardWords: [
    { word: '竟然', lapses: 7 },
    { word: '培养', lapses: 4 },
    { word: '梦想', lapses: 1 },
  ],
};

const chars = (r: { char: string }[]) => r.map((e) => e.char).join('');

describe('selectDoubleDown', () => {
  it('draws from all three sources', () => {
    const out = selectDoubleDown(input, { count: 12 });
    const reasons = new Set(out.map((e) => e.reason));
    expect(reasons).toEqual(new Set(['new', 'class', 'hard']));
  });

  it('labels each character with where it came from', () => {
    const out = selectDoubleDown(input, { count: 12 });
    expect(out.find((e) => e.char === '塑')!.reason).toBe('new');
    expect(out.find((e) => e.char === '友')!.reason).toBe('class');
    expect(out.find((e) => e.char === '竟')!.reason).toBe('hard');
  });

  it('keeps the source word for context on the sheet', () => {
    const out = selectDoubleDown(input, { count: 12 });
    expect(out.find((e) => e.char === '塑')!.sourceWord).toBe('塑料');
  });

  it('takes the hardest cards first, by lapse count', () => {
    const out = selectDoubleDown(input, { count: 12 });
    const hard = out.filter((e) => e.reason === 'hard').map((e) => e.char);
    expect(hard.indexOf('竟')).toBeLessThan(hard.indexOf('培'));
  });

  it('never repeats a character across sources', () => {
    const out = selectDoubleDown(
      { yesterdayWords: ['塑料'], classWords: ['塑料'], hardWords: [{ word: '塑料', lapses: 9 }] },
      { count: 10 },
    );
    expect(chars(out)).toBe('塑料');
  });

  it('honours the requested count exactly when there is enough material', () => {
    expect(selectDoubleDown(input, { count: 4 })).toHaveLength(4);
  });

  it('returns everything available when there is not enough', () => {
    const out = selectDoubleDown({ yesterdayWords: ['八'], classWords: [], hardWords: [] }, { count: 14 });
    expect(chars(out)).toBe('八');
  });

  it('drops skip-list characters', () => {
    const out = selectDoubleDown(
      { yesterdayWords: ['一个人'], classWords: [], hardWords: [] },
      { count: 10, skip: ['一', '人'] },
    );
    expect(chars(out)).toBe('个');
  });

  it('excludes characters already placed on the sheet', () => {
    const out = selectDoubleDown(input, { count: 12, exclude: ['塑', '料'] });
    expect(chars(out)).not.toMatch(/[塑料]/);
  });

  it('is deterministic', () => {
    expect(chars(selectDoubleDown(input, { count: 6 }))).toBe(chars(selectDoubleDown(input, { count: 6 })));
  });
});

describe('selectDoubleDown — quotas', () => {
  const big: DoubleDownInput = {
    yesterdayWords: ['天长地久', '付诸实践'],
    classWords: ['龙飞凤舞', '纹丝不动'],
    hardWords: [{ word: '魔鬼式', lapses: 5 }, { word: '绘图员', lapses: 3 }],
  };

  it('spreads across sources rather than exhausting the first', () => {
    const out = selectDoubleDown(big, { count: 6, quota: { new: 2, class: 2, hard: 2 } });
    const counts = { new: 0, class: 0, hard: 0 } as Record<string, number>;
    for (const e of out) counts[e.reason] = (counts[e.reason] ?? 0) + 1;
    expect(counts).toEqual({ new: 2, class: 2, hard: 2 });
  });

  // A quiet week should still fill the sheet, not leave it half empty.
  it('redistributes an unfilled quota to the other sources', () => {
    const out = selectDoubleDown(
      { yesterdayWords: [], classWords: ['龙飞凤舞'], hardWords: [{ word: '魔鬼式', lapses: 5 }] },
      { count: 6, quota: { new: 2, class: 2, hard: 2 } },
    );
    expect(out).toHaveLength(6);
  });

  it('prefers new vocab when everything is short', () => {
    const out = selectDoubleDown(
      { yesterdayWords: ['塑料'], classWords: ['关怀'], hardWords: [] },
      { count: 3, quota: { new: 1, class: 1, hard: 1 } },
    );
    expect(out[0]!.reason).toBe('new');
  });
});
