import { describe, it, expect } from 'vitest';
import { buildLinearSequence, selectLinear } from './linear.js';
import { createCatalogue, parseCharList, parseFrequency, loadHsk } from '../sources/hsk.js';
import { join } from 'node:path';

const SAMPLE = `一级汉字表
1\t爱
2\t八
3\t好
二级汉字表
1\t啊
2\t板
七一九级汉字表
1\t哎
初等手写字表
1\t爱
2\t好
中等手写字表
1\t啊
高等手写字表
1\t板
`;

// 爱=elementary, 好=elementary, 啊=intermediate, 板=advanced, 八/哎=reading-only.
// Ranks are spread so band medians are distinguishable: 新 (15) should fall inside the
// elementary band, 稀 (900) far outside every band.
const FREQ = '10\t好\n20\t爱\n30\t啊\n40\t板\n50\t八\n60\t哎\n15\t新\n900\t稀\n';
const cat = createCatalogue(parseCharList(SAMPLE), parseFrequency(FREQ));

describe('buildLinearSequence', () => {
  it('walks handwriting bands before recognition-only characters', () => {
    expect(buildLinearSequence(cat).map((e) => e.char)).toEqual(['好', '爱', '啊', '板', '八', '哎']);
  });

  it('orders within each band by frequency, most common first', () => {
    const seq = buildLinearSequence(cat).map((e) => e.char);
    expect(seq.indexOf('好')).toBeLessThan(seq.indexOf('爱'));
  });

  it('keeps the band on each entry so the sheet can show it', () => {
    const seq = buildLinearSequence(cat);
    expect(seq[0]).toMatchObject({ char: '好', handwritingBand: 'elementary' });
    expect(seq.at(-1)).toMatchObject({ handwritingBand: null });
  });

  it('ignores Anki extras unless asked for them', () => {
    const seq = buildLinearSequence(cat, { ankiExtras: ['新'] });
    expect(seq.map((e) => e.char)).not.toContain('新');
  });

  it('interleaves a common Anki extra into the band its frequency earns', () => {
    const seq = buildLinearSequence(cat, {
      ankiExtras: ['新'],
      includeAnkiExtras: true,
      frequency: parseFrequency(FREQ),
    });
    // 新 (rank 15) sits between 好 (10) and 爱 (20), inside the elementary band.
    expect(seq.map((e) => e.char)).toEqual(['好', '新', '爱', '啊', '板', '八', '哎']);
    expect(seq[1]).toMatchObject({ char: '新', handwritingBand: 'elementary' });
  });

  it('places a rare Anki extra after every handwriting band', () => {
    const seq = buildLinearSequence(cat, {
      ankiExtras: ['稀'],
      includeAnkiExtras: true,
      frequency: parseFrequency(FREQ),
    }).map((e) => e.char);
    expect(seq.indexOf('稀')).toBeGreaterThan(seq.indexOf('板'));
    expect(seq.at(-1)).toBe('稀');
  });

  it('ignores extras that are already HSK characters', () => {
    const seq = buildLinearSequence(cat, {
      ankiExtras: ['爱'],
      includeAnkiExtras: true,
      frequency: parseFrequency(FREQ),
    });
    expect(seq.filter((e) => e.char === '爱')).toHaveLength(1);
  });

  it('can stop after the handwriting phase', () => {
    const seq = buildLinearSequence(cat, { phase: 'handwriting' }).map((e) => e.char);
    expect(seq).toEqual(['好', '爱', '啊', '板']);
  });
});

describe('selectLinear', () => {
  const seq = buildLinearSequence(cat);

  it('takes the first characters when nothing is done', () => {
    expect(selectLinear(seq, { done: [], count: 2 }).map((e) => e.char)).toEqual(['好', '爱']);
  });

  it('resumes after what is already done', () => {
    expect(selectLinear(seq, { done: ['好', '爱'], count: 2 }).map((e) => e.char)).toEqual(['啊', '板']);
  });

  // A done-set, not an index: editing the skip list must not silently shift your position.
  it('is unaffected by a skip-list change reordering the sequence', () => {
    const withSkip = buildLinearSequence(cat, { skip: ['好'] });
    expect(selectLinear(withSkip, { done: ['爱'], count: 2 }).map((e) => e.char)).toEqual(['啊', '板']);
  });

  it('never returns a done character even if it reappears', () => {
    expect(selectLinear(seq, { done: ['啊'], count: 6 }).map((e) => e.char)).not.toContain('啊');
  });

  it('returns fewer than asked when the sequence runs out', () => {
    expect(selectLinear(seq, { done: [], count: 100 })).toHaveLength(6);
  });

  it('returns nothing once everything is done', () => {
    const all = seq.map((e) => e.char);
    expect(selectLinear(seq, { done: all, count: 5 })).toEqual([]);
  });

  it('is deterministic — the same inputs give the same characters', () => {
    const a = selectLinear(seq, { done: ['好'], count: 3 }).map((e) => e.char);
    const b = selectLinear(seq, { done: ['好'], count: 3 }).map((e) => e.char);
    expect(a).toEqual(b);
  });
});

describe('linear over the real HSK data', () => {
  const real = loadHsk(
    join(process.cwd(), 'data/hsk30-charlist.txt'),
    join(process.cwd(), 'data/char-frequency.txt'),
  );

  it('covers all 3,000 characters, handwriting first', () => {
    const seq = buildLinearSequence(real);
    expect(seq).toHaveLength(3000);
    expect(seq.slice(0, 1200).every((e) => e.handwritingBand !== null)).toBe(true);
    expect(seq.slice(1200).every((e) => e.handwritingBand === null)).toBe(true);
  });

  it('starts with the most common characters you must write', () => {
    const first = buildLinearSequence(real).slice(0, 5).map((e) => e.char);
    expect(first).toEqual(['的', '一', '是', '不', '了']);
  });

  it('removes skip-list characters from the sequence entirely', () => {
    const seq = buildLinearSequence(real, { skip: ['的', '一', '是'] });
    expect(seq.slice(0, 3).map((e) => e.char)).toEqual(['不', '了', '在']);
    expect(seq).toHaveLength(2997);
  });

  it('gives a sensible first sheet', () => {
    const seq = buildLinearSequence(real, { skip: ['一', '不', '了'] });
    expect(selectLinear(seq, { done: [], count: 14 })).toHaveLength(14);
  });
});
