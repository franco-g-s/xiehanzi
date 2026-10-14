import { describe, it, expect } from 'vitest';
import { parseCharList, parseFrequency, createCatalogue, loadHsk } from './hsk.js';
import { join } from 'node:path';

const SAMPLE = `# comment line
一级汉字表
1\t爱
2\t八
二级汉字表
1\t啊
七一九级汉字表
1\t哎
初等手写字表
1\t爱
中等手写字表
1\t啊
`;

describe('parseCharList', () => {
  const chars = parseCharList(SAMPLE);
  const get = (c: string) => chars.find((x) => x.char === c);

  it('skips comments and returns one record per character', () => {
    expect(chars.map((c) => c.char).sort()).toEqual(['八', '啊', '哎', '爱'].sort());
  });

  it('reads the reading level from the section header', () => {
    expect(get('爱')!.readingLevel).toBe(1);
    expect(get('啊')!.readingLevel).toBe(2);
  });

  // The OCR renders 七–九级 as 七一九级; it is one combined section covering 7-9.
  it('maps the combined 七一九级 section to level 7', () => {
    expect(get('哎')!.readingLevel).toBe(7);
  });

  it('records the handwriting band, or null when the character is read-only', () => {
    expect(get('爱')!.handwritingBand).toBe('elementary');
    expect(get('啊')!.handwritingBand).toBe('intermediate');
    expect(get('哎')!.handwritingBand).toBeNull();
  });

  it('merges the two taxonomies into one record per character', () => {
    expect(chars.filter((c) => c.char === '爱')).toHaveLength(1);
  });
});

describe('parseFrequency', () => {
  it('reads rank and character, ignoring comments', () => {
    const f = parseFrequency('# note\n1\t的\n2\t一\n');
    expect(f.get('的')).toBe(1);
    expect(f.get('一')).toBe(2);
    expect(f.get('鬃')).toBeUndefined();
  });
});

describe('createCatalogue', () => {
  const cat = createCatalogue(parseCharList(SAMPLE), parseFrequency('1\t爱\n5\t啊\n'));

  it('joins frequency onto the characters', () => {
    expect(cat.get('爱')!.frequencyRank).toBe(1);
  });

  it('leaves frequency null when the character is not in the list', () => {
    expect(cat.get('哎')!.frequencyRank).toBeNull();
  });

  it('returns undefined for a character outside HSK entirely', () => {
    expect(cat.get('鬃')).toBeUndefined();
  });

  it('exposes handwriting bands in order', () => {
    expect(cat.handwriting('elementary').map((c) => c.char)).toEqual(['爱']);
    expect(cat.handwriting('advanced')).toEqual([]);
  });

  it('exposes the read-only characters — recognise but never write', () => {
    // 八 is a level-1 reading character that the standard never asks you to write.
    expect(cat.readingOnly().map((c) => c.char)).toEqual(['八', '哎']);
  });
});

// Guards against a bad re-download of the vendored data.
describe('the vendored HSK data', () => {
  const cat = loadHsk(
    join(process.cwd(), 'data/hsk30-charlist.txt'),
    join(process.cwd(), 'data/char-frequency.txt'),
  );

  it('has the 3,000 characters the standard defines', () => {
    expect(cat.all()).toHaveLength(3000);
  });

  it('has 1,200 handwriting characters split 300/400/500', () => {
    expect(cat.handwriting('elementary')).toHaveLength(300);
    expect(cat.handwriting('intermediate')).toHaveLength(400);
    expect(cat.handwriting('advanced')).toHaveLength(500);
  });

  it('leaves 1,800 characters as recognition-only', () => {
    expect(cat.readingOnly()).toHaveLength(1800);
  });

  it('has a frequency rank for every handwriting character', () => {
    const missing = (['elementary', 'intermediate', 'advanced'] as const)
      .flatMap((b) => cat.handwriting(b))
      .filter((c) => c.frequencyRank === null);
    expect(missing).toEqual([]);
  });

  it('agrees with known facts about the standard', () => {
    expect(cat.get('爱')!.readingLevel).toBe(1);
    expect(cat.get('的')!.frequencyRank).toBe(1);
    // 我 is level 1 and must be written by hand.
    expect(cat.get('我')!.handwritingBand).toBe('elementary');
  });
});
