import { describe, it, expect } from 'vitest';
import { decompose, isHanzi } from './decompose.js';

describe('isHanzi', () => {
  it('accepts common ideographs', () => {
    expect(isHanzi('我')).toBe(true);
    expect(isHanzi('爱')).toBe(true);
  });

  it('rejects CJK punctuation, latin, digits and whitespace', () => {
    for (const c of ['。', '，', '、', '！', '？', 'a', 'Z', '4', ' ', '　', '·']) {
      expect(isHanzi(c), `${c} should not be hanzi`).toBe(false);
    }
  });

  it('accepts characters outside the BMP', () => {
    // U+20BB7 — a CJK Extension B ideograph, two UTF-16 units
    expect(isHanzi('\u{20BB7}')).toBe(true);
  });
});

describe('decompose', () => {
  it('splits a multi-character word into its hanzi', () => {
    expect(decompose(['冰激凌']).map((d) => d.char)).toEqual(['冰', '激', '凌']);
  });

  it('records the word each character came from', () => {
    expect(decompose(['冰激凌'])[0]).toEqual({ char: '冰', sourceWord: '冰激凌' });
  });

  it('deduplicates across words, keeping first-seen order and first source', () => {
    const out = decompose(['父亲', '父母']);
    expect(out.map((d) => d.char)).toEqual(['父', '亲', '母']);
    expect(out[0]!.sourceWord).toBe('父亲');
  });

  it('strips punctuation, latin and digits', () => {
    expect(decompose(['我爱我的家人。']).map((d) => d.char)).toEqual(['我', '爱', '的', '家', '人']);
    expect(decompose(['HSK4级']).map((d) => d.char)).toEqual(['级']);
  });

  it('does not leak letters out of HTML markup', () => {
    expect(decompose(['我<b>闻</b>到']).map((d) => d.char)).toEqual(['我', '闻', '到']);
  });

  it('handles characters outside the BMP without splitting surrogate pairs', () => {
    const out = decompose(['\u{20BB7}好']);
    expect(out.map((d) => d.char)).toEqual(['\u{20BB7}', '好']);
  });

  it('removes skip-list characters', () => {
    const out = decompose(['一个人'], { skip: ['一', '人'] });
    expect(out.map((d) => d.char)).toEqual(['个']);
  });

  it('accepts a Set as the skip list', () => {
    const out = decompose(['一个人'], { skip: new Set(['个']) });
    expect(out.map((d) => d.char)).toEqual(['一', '人']);
  });

  it('returns an empty array for empty or hanzi-free input', () => {
    expect(decompose([])).toEqual([]);
    expect(decompose(['', '   ', 'hello!'])).toEqual([]);
  });
});
