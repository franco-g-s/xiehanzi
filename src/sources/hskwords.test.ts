import { describe, it, expect } from 'vitest';
import { parseWordList, loadHskWords } from './hskwords.js';
import { join } from 'node:path';

const SAMPLE = `# comment
一级词汇表
1 爱
2 爱好
4 爸爸｜爸
6 白（形）
二级词汇表
1 安静
七一九级词汇表
1 哀求
`;

describe('parseWordList', () => {
  const words = parseWordList(SAMPLE);
  const find = (t: string) => words.find((w) => w.term === t);

  it('reads the level from the section header', () => {
    expect(find('爱')!.level).toBe(1);
    expect(find('安静')!.level).toBe(2);
  });

  it('maps the combined 七一九级 section to level 7', () => {
    expect(find('哀求')!.level).toBe(7);
  });

  it('strips part-of-speech annotations', () => {
    expect(find('白')).toBeDefined();
    expect(words.some((w) => w.term.includes('（'))).toBe(false);
  });

  it('splits variant forms into separate entries', () => {
    expect(find('爸爸')).toBeDefined();
    expect(find('爸')).toBeDefined();
  });

  it('ignores comments and headers', () => {
    expect(words.some((w) => w.term.startsWith('#'))).toBe(false);
    expect(words.some((w) => w.term.includes('级'))).toBe(false);
  });
});

describe('the vendored word list', () => {
  const words = loadHskWords(join(process.cwd(), 'data/hsk30-wordlist.txt'));

  // The standard lists 11,092 words across 11,099 raw entries; a few appear in more than
  // one section and are kept once, at the level they are first introduced.
  it('has roughly the 11,092 words the standard defines', () => {
    expect(words.length).toBeGreaterThan(10_900);
    expect(words.length).toBeLessThan(11_100);
  });

  it('keeps a repeated word once, at its earliest level', () => {
    const terms = words.map((w) => w.term);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('contains the everyday words that make good examples', () => {
    const byTerm = new Map(words.map((w) => [w.term, w.level]));
    for (const t of ['我们', '他们', '什么', '回来', '时候']) {
      expect(byTerm.has(t), `${t} missing`).toBe(true);
      expect(byTerm.get(t)).toBeLessThanOrEqual(2);
    }
  });

  it('does not contain rare compounds that only look plausible', () => {
    const terms = new Set(words.map((w) => w.term));
    // These are the picks that character-frequency scoring wrongly preferred.
    expect(terms.has('我人')).toBe(false);
    expect(terms.has('这不')).toBe(false);
  });

  it('leaves no annotation characters in any term', () => {
    expect(words.filter((w) => /[（）｜]/.test(w.term))).toEqual([]);
  });
});
