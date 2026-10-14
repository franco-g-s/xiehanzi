import { describe, it, expect } from 'vitest';
import { toneMarks, syllableToneMarks } from './pinyin.js';

describe('syllableToneMarks', () => {
  it('marks a when present, wherever it sits', () => {
    expect(syllableToneMarks('hao3')).toBe('hǎo');
    expect(syllableToneMarks('mai4')).toBe('mài');
    expect(syllableToneMarks('guang1')).toBe('guāng');
  });

  it('marks o or e when there is no a', () => {
    expect(syllableToneMarks('ou3')).toBe('ǒu');
    expect(syllableToneMarks('xie4')).toBe('xiè');
    expect(syllableToneMarks('er2')).toBe('ér');
  });

  // The iu/ui rule: with no a/o/e the mark lands on the LAST vowel.
  it('marks the last vowel for iu and ui', () => {
    expect(syllableToneMarks('liu4')).toBe('liù');
    expect(syllableToneMarks('gui4')).toBe('guì');
  });

  it('handles all four tones plus neutral', () => {
    expect(syllableToneMarks('ma1')).toBe('mā');
    expect(syllableToneMarks('ma2')).toBe('má');
    expect(syllableToneMarks('ma3')).toBe('mǎ');
    expect(syllableToneMarks('ma4')).toBe('mà');
    expect(syllableToneMarks('ma5')).toBe('ma');
    expect(syllableToneMarks('ma')).toBe('ma');
  });

  it('converts CEDICT u: into ü', () => {
    expect(syllableToneMarks('lu:4')).toBe('lǜ');
    expect(syllableToneMarks('nu:3')).toBe('nǚ');
    expect(syllableToneMarks('nu:5')).toBe('nü');
  });

  it('preserves capitalisation for proper nouns', () => {
    expect(syllableToneMarks('Bei3')).toBe('Běi');
    expect(syllableToneMarks('Zhong1')).toBe('Zhōng');
  });

  it('leaves tokens with no vowel untouched', () => {
    expect(syllableToneMarks('11')).toBe('11');
    expect(syllableToneMarks('')).toBe('');
  });
});

describe('toneMarks', () => {
  it('converts a whole CEDICT reading, joined', () => {
    expect(toneMarks('su4 liao4')).toBe('sùliào');
    expect(toneMarks('bing1 ji1 ling2')).toBe('bīngjīlíng');
  });

  it('preserves proper-noun capitalisation across syllables', () => {
    expect(toneMarks('Bei3 jing1')).toBe('Běijīng');
  });

  it('returns syllables separately when asked', () => {
    expect(toneMarks('su4 liao4', { join: false })).toEqual(['sù', 'liào']);
  });

  it('handles the erhua r5 suffix', () => {
    expect(toneMarks('wan2 r5')).toBe('wánr');
  });
});
