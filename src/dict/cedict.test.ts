import { describe, it, expect } from 'vitest';
import { parseCedictLine, parseCedict, createDictionary } from './cedict.js';

const LINE = '塑料 塑料 [su4 liao4] /plastic; plastics (general term for synthetic polymer materials)/';
const TRAD = '學習 学习 [xue2 xi2] /to learn/to study/';

describe('parseCedictLine', () => {
  it('pulls out both scripts, the raw reading and tone-marked pinyin', () => {
    expect(parseCedictLine(LINE)).toEqual({
      traditional: '塑料',
      simplified: '塑料',
      reading: 'su4 liao4',
      pinyin: 'sùliào',
      syllables: ['sù', 'liào'],
      definitions: ['plastic; plastics (general term for synthetic polymer materials)'],
    });
  });

  it('keeps traditional and simplified apart when they differ', () => {
    const entry = parseCedictLine(TRAD)!;
    expect(entry.traditional).toBe('學習');
    expect(entry.simplified).toBe('学习');
  });

  it('splits multiple definitions on the slash', () => {
    expect(parseCedictLine(TRAD)!.definitions).toEqual(['to learn', 'to study']);
  });

  it('ignores comments and blank lines', () => {
    expect(parseCedictLine('# CC-CEDICT')).toBeNull();
    expect(parseCedictLine('#! version=1')).toBeNull();
    expect(parseCedictLine('')).toBeNull();
    expect(parseCedictLine('   ')).toBeNull();
  });

  it('returns null rather than throwing on a malformed line', () => {
    expect(parseCedictLine('this is not cedict')).toBeNull();
  });
});

describe('parseCedict', () => {
  it('parses many lines and drops the header', () => {
    const entries = parseCedict(['# header', '#! version=1', LINE, '', TRAD].join('\n'));
    expect(entries).toHaveLength(2);
    expect(entries[0]!.simplified).toBe('塑料');
  });
});

describe('createDictionary', () => {
  const dict = createDictionary(parseCedict([LINE, TRAD].join('\n')));

  it('looks up by simplified', () => {
    expect(dict.lookup('塑料')[0]!.pinyin).toBe('sùliào');
  });

  it('looks up by traditional too', () => {
    expect(dict.lookup('學習')[0]!.simplified).toBe('学习');
  });

  it('returns an empty array for an unknown term', () => {
    expect(dict.lookup('鬃鬃鬃')).toEqual([]);
  });

  it('returns every homograph, not just the first', () => {
    const many = createDictionary(
      parseCedict(['了 了 [le5] /(particle)/', '了 了 [liao3] /to finish/'].join('\n')),
    );
    expect(many.lookup('了').map((e) => e.pinyin)).toEqual(['le', 'liǎo']);
  });
});

// The cue bolds the syllable belonging to the character it is asking for, which means it
// needs the reading split, not joined. `toneMarks` already splits; cedict threw the split
// away and kept only the join.
describe('parseCedictLine — syllables', () => {
  it('keeps the reading split into one syllable per hanzi', () => {
    expect(parseCedictLine('城市 城市 [cheng2 shi4] /city/')!.syllables).toEqual(['chéng', 'shì']);
  });

  it('joins to exactly the pinyin it already reported', () => {
    const entry = parseCedictLine('塑料 塑料 [su4 liao4] /plastic/')!;
    expect(entry.syllables.join('')).toBe(entry.pinyin);
  });

  it('gives a single character a single syllable', () => {
    expect(parseCedictLine('市 市 [shi4] /market/')!.syllables).toEqual(['shì']);
  });
});
