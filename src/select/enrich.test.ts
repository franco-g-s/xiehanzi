import { describe, it, expect } from 'vitest';
import { enrich, createExampleIndex, tidyGloss } from './enrich.js';
import { createGlossary } from '../sources/glossary.js';
import { createDictionary, parseCedict } from '../dict/cedict.js';

const DICT = createDictionary(
  parseCedict(
    [
      '塑料 塑料 [su4 liao4] /plastic/',
      '塑 塑 [su4] /to model (a figure) in clay/',
      '料 料 [liao4] /material/to expect/',
      '了 了 [le5] /(completed action marker)/',
      '了 了 [liao3] /to finish/',
      '雕塑 雕塑 [diao1 su4] /sculpture/',
      '塑造 塑造 [su4 zao4] /to mould/',
      '木 木 [mu4] /tree/wood/',
      '木頭 木头 [mu4 tou5] /slow-witted/wood/',
    ].join('\n'),
  ),
);

describe('enrich', () => {
  it('fills in pinyin and meaning from the dictionary', () => {
    const [out] = enrich([{ char: '塑', reason: 'linear' }], { dictionary: DICT });
    expect(out!.pinyin).toBe('sù');
    expect(out!.meaning).toContain('clay');
  });

  it('shows more than one reading for a homograph', () => {
    const [out] = enrich([{ char: '了', reason: 'linear' }], { dictionary: DICT });
    expect(out!.pinyin).toContain('le');
    expect(out!.pinyin).toContain('liǎo');
  });

  it('records the stroke count from the glyph data', () => {
    const [out] = enrich([{ char: '木', reason: 'linear' }], { dictionary: DICT });
    expect(out!.strokeCount).toBe(4);
  });

  it('degrades to the character alone when the dictionary has nothing', () => {
    const [out] = enrich([{ char: '鬃', reason: 'linear' }], { dictionary: DICT });
    expect(out!.char).toBe('鬃');
    expect(out!.pinyin).toBe('');
    expect(out!.meaning).toBe('');
  });
});

// Examples now come from a graded vocabulary list, not the dictionary.
const VOCAB = [
  { term: '塑料', level: 4 },
  { term: '雕塑', level: 6 },
  { term: '塑造', level: 6 },
  { term: '木头', level: 5 },
];

describe('enrich — example terms', () => {
  const index = createExampleIndex(VOCAB);

  it('prefers the word the character actually came from', () => {
    const [out] = enrich([{ char: '塑', sourceWord: '塑料', reason: 'new' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example?.term).toBe('塑料');
  });

  it('ignores a single-character source word as an example', () => {
    const [out] = enrich([{ char: '木', sourceWord: '木', reason: 'new' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example?.term).not.toBe('木');
  });

  it('finds a term containing the character when there is no source word', () => {
    const [out] = enrich([{ char: '塑', reason: 'linear' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example?.term).toMatch(/塑/);
    expect(out!.example!.term.length).toBeGreaterThan(1);
  });

  it('prefers a word you are already learning over a dictionary pick', () => {
    const [out] = enrich([{ char: '塑', reason: 'linear' }], {
      dictionary: DICT,
      examples: index,
      knownWords: ['雕塑'],
    });
    expect(out!.example?.term).toBe('雕塑');
  });

  it('gives the example its own pinyin and meaning', () => {
    const [out] = enrich([{ char: '塑', sourceWord: '塑料', reason: 'new' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example?.pinyin).toBe('sùliào');
    expect(out!.example?.meaning).toBe('plastic');
  });

  it('leaves the example out entirely rather than inventing one', () => {
    const [out] = enrich([{ char: '鬃', reason: 'linear' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example).toBeUndefined();
  });

  it('prefers shorter terms — two characters read better on a sheet', () => {
    const [out] = enrich([{ char: '木', reason: 'linear' }], {
      dictionary: DICT,
      examples: index,
    });
    expect(out!.example!.term).toHaveLength(2);
  });

  it('prefers an easier word over a harder one', () => {
    const idx = createExampleIndex([
      { term: '塑造', level: 6 },
      { term: '塑料', level: 4 },
    ]);
    const [out] = enrich([{ char: '塑', reason: 'linear' }], { dictionary: DICT, examples: idx });
    expect(out!.example?.term).toBe('塑料');
  });

  it('carries the selection reason through untouched', () => {
    const [out] = enrich([{ char: '塑', reason: 'hard' }], { dictionary: DICT });
    expect(out!.reason).toBe('hard');
  });
});

describe('tidyGloss', () => {
  it('keeps only the first sense', () => {
    expect(tidyGloss('to have; there is; to exist')).toBe('to have');
  });

  it('strips CC-CEDICT cross-reference apparatus', () => {
    expect(tidyGloss('you (plural) (slang alternative for 你們|你们[ni3 men5])')).not.toContain('|');
    expect(tidyGloss('variant of 說|说[shuo1]')).not.toContain('[');
  });

  it('truncates a gloss that would push the filmstrip off the row', () => {
    const long = 'a'.repeat(120);
    expect(tidyGloss(long).length).toBeLessThanOrEqual(42);
    expect(tidyGloss(long)).toMatch(/…$/);
  });

  it('leaves a short gloss alone', () => {
    expect(tidyGloss('habit')).toBe('habit');
  });
});

describe('enrich — example source', () => {
  const dict = createDictionary(
    parseCedict(
      [
        '們 们 [men5] /plural marker/',
        '我們 我们 [wo3 men5] /we/',
        '我人 我人 [wo3 ren2] /rare compound/',
        '我 我 [wo3] /I/',
      ].join('\n'),
    ),
  );

  // 我人 is a real dictionary entry made of two very common characters. Only a graded
  // vocabulary list rules it out.
  it('never offers a word that is not in the graded list', () => {
    const idx = createExampleIndex([{ term: '我们', level: 1 }]);
    const [out] = enrich([{ char: '我', reason: 'linear' }], { dictionary: dict, examples: idx });
    expect(out!.example?.term).toBe('我们');
  });

  it('still shows a graded word that the dictionary has never heard of', () => {
    const idx = createExampleIndex([{ term: '我朋', level: 1 }]);
    const [out] = enrich([{ char: '我', reason: 'linear' }], { dictionary: dict, examples: idx });
    expect(out!.example?.term).toBe('我朋');
    expect(out!.example?.meaning).toBe('');
  });
});

describe('tidyGloss — truncation tidiness', () => {
  it('does not cut in the middle of a parenthetical', () => {
    const out = tidyGloss('to be (followed by substantives only, in most cases)');
    expect(out).not.toContain('(');
    expect(out).toMatch(/…$/);
  });

  it('keeps a parenthetical that fits whole', () => {
    expect(tidyGloss('of (possessive)')).toBe('of (possessive)');
  });
});

describe('enrich — surname and variant entries', () => {
  const dict = createDictionary(
    parseCedict(
      [
        '和 和 [He2] /old variant of 和/',
        '和 和 [he2] /and; together with/',
        '國 国 [Guo2] /surname Guo/',
        '國 国 [guo2] /country; nation/',
        '甲 甲 [jia3] /first of the ten Heavenly Stems/',
      ].join('\n'),
    ),
  );

  it('skips a leading "old variant of" entry', () => {
    const [out] = enrich([{ char: '和', reason: 'linear' }], { dictionary: dict });
    expect(out!.meaning).toBe('and');
  });

  it('skips a leading surname entry', () => {
    const [out] = enrich([{ char: '国', reason: 'linear' }], { dictionary: dict });
    expect(out!.meaning).toBe('country');
  });

  it('does not offer the surname reading as the pinyin', () => {
    const [out] = enrich([{ char: '国', reason: 'linear' }], { dictionary: dict });
    expect(out!.pinyin).toBe('guó');
  });

  it('falls back to the meta entry when it is all there is', () => {
    const [out] = enrich([{ char: '甲', reason: 'linear' }], { dictionary: dict });
    expect(out!.meaning).toContain('Heavenly Stems');
  });
});

// CC-CEDICT gives the first substantive sense, which is routinely not the sense anyone
// learns first: 着 came off a real sheet as "a move in chess (Taiwan pr.)", 老 as "prefix
// used before the surname of a person". Franco's own Anki deck holds the gloss he actually
// studied, and that is the one the cue should print.
describe('enrich — Franco\'s own glossary', () => {
  const dict = createDictionary(
    parseCedict(
      [
        '老 老 [lao3] /prefix used before the surname of a person/old/',
        '老師 老师 [lao3 shi1] /teacher/',
        '西 西 [Xi1] /the West/',
        '塑料 塑料 [su4 liao4] /plastic/',
        '塑 塑 [su4] /to model (a figure) in clay/',
      ].join('\n'),
    ),
  );
  const glossary = createGlossary({
    老: { definition: 'old; aged', pinyin: 'lǎo' },
    老师: { definition: 'Teacher', pinyin: 'lǎoshī' },
  });
  const examples = createExampleIndex([{ term: '老师', level: 1 }, { term: '塑料', level: 4 }]);

  it('prefers the studied definition over the dictionary\'s first substantive sense', () => {
    const [out] = enrich([{ char: '老', reason: 'linear' }], { dictionary: dict, glossary });
    expect(out!.meaning).toBe('old; aged');
  });

  it('falls back to CC-CEDICT for a character the deck has never taught', () => {
    const [out] = enrich([{ char: '西', reason: 'linear' }], { dictionary: dict, glossary });
    expect(out!.meaning).toBe('the West');
  });

  it('uses the studied definition for the example word too', () => {
    const [out] = enrich([{ char: '老', reason: 'linear' }], {
      dictionary: dict, examples, glossary,
    });
    expect(out!.example?.term).toBe('老师');
    expect(out!.example?.meaning).toBe('Teacher');
  });

  it('falls back to CC-CEDICT for an example word the deck has never taught', () => {
    const [out] = enrich([{ char: '塑', reason: 'linear' }], {
      dictionary: dict, examples, glossary,
    });
    expect(out!.example?.meaning).toBe('plastic');
  });

  // CRITICAL: change 3 splits the reading into syllables to bold the one belonging to the
  // blanked character, and only CEDICT's numbered form can be split — Anki's is already
  // joined. Mixing the two sources for one field is how a cue ends up bolding the wrong
  // syllable, so the definition comes from Anki and the reading stays CEDICT's.
  it('keeps the pinyin from CC-CEDICT even when the deck has its own', () => {
    const [out] = enrich([{ char: '老', reason: 'linear' }], {
      dictionary: dict, examples, glossary,
    });
    expect(out!.pinyin).toBe('lǎo');
    expect(out!.example?.pinyin).toBe('lǎoshī');
  });

  // A studied gloss is written by hand and short; its semicolons separate senses worth
  // keeping ("old; aged"), unlike CC-CEDICT's, which separate a dictionary's worth of them.
  it('keeps every sense of a studied gloss, rather than cutting at the first semicolon', () => {
    const [out] = enrich([{ char: '老', reason: 'linear' }], { dictionary: dict, glossary });
    expect(out!.meaning).toContain('aged');
  });

  it('still caps a studied gloss that would push the filmstrip off the row', () => {
    const long = createGlossary({ 老: { definition: 'a'.repeat(120), pinyin: 'lǎo' } });
    const [out] = enrich([{ char: '老', reason: 'linear' }], { dictionary: dict, glossary: long });
    expect(out!.meaning.length).toBeLessThanOrEqual(42);
  });

  // The unglossed path is left exactly as it was — including the gloss Franco complained
  // about, which is the whole reason the glossary exists.
  it('behaves exactly as before when no glossary is supplied', () => {
    const [out] = enrich([{ char: '老', reason: 'linear' }], { dictionary: dict, examples });
    expect(out!.meaning).toBe('prefix used before the surname of a person');
  });
});

describe('enrich — the example word\'s syllables', () => {
  const idx = createExampleIndex(VOCAB);

  // The cue emboldens the syllable belonging to the character it is asking for, and can
  // only do that if it is told where the syllable boundaries are.
  it('carries the example\'s reading through split as well as joined', () => {
    const [out] = enrich([{ char: '塑', sourceWord: '塑料', reason: 'new' }], {
      dictionary: DICT, examples: idx,
    });
    expect(out!.example?.syllables).toEqual(['sù', 'liào']);
    expect(out!.example?.pinyin).toBe('sùliào');
  });

  it('leaves the syllables off a term the dictionary has never heard of', () => {
    const [out] = enrich([{ char: '我', sourceWord: '我朋', reason: 'new' }], {
      dictionary: DICT, examples: idx,
    });
    expect(out!.example?.syllables).toBeUndefined();
  });
});

// 负 and 责 both come from 负责, so on a day both are due, both rows blank to "＿＿ fùzé" —
// and buildCues then has to drop BOTH example words and cue the bare characters. Choosing
// an example that contains no other answer in the first place keeps the word cue, which is
// the better cue; the bare-character fallback stays, but as a last resort rather than a
// routine one. Characters due the same day come off the same drill sheet, so their HSK
// example words overlap constantly — this is structural, not rare.
describe('enrich — examples that avoid the sheet\'s other answers', () => {
  const dict = createDictionary(
    parseCedict(
      [
        '負責 负责 [fu4 ze2] /to be responsible for/',
        '負擔 负担 [fu4 dan1] /burden/',
        '負 负 [fu4] /to bear/',
        '責 责 [ze2] /duty/',
        '他們 他们 [ta1 men5] /they/',
        '他人 他人 [ta1 ren2] /another person/',
        '他 他 [ta1] /he/',
        '們 们 [men5] /plural marker/',
      ].join('\n'),
    ),
  );
  const examples = createExampleIndex([
    { term: '负责', level: 1 },
    { term: '负担', level: 4 },
    { term: '他们', level: 1 },
    { term: '他人', level: 4 },
  ]);

  it('prefers a term containing none of the other answers', () => {
    const [out] = enrich([{ char: '负', reason: 'linear' }], {
      dictionary: dict, examples, avoid: new Set(['负', '责']),
    });
    expect(out!.example?.term).toBe('负担');
  });

  it('never avoids the row\'s own character — the example has to contain it', () => {
    const [out] = enrich([{ char: '他', reason: 'linear' }], {
      dictionary: dict, examples, avoid: new Set(['他']),
    });
    expect(out!.example?.term).toBe('他们');
  });

  it('takes the easiest word as before when nothing has to be avoided', () => {
    const [out] = enrich([{ char: '负', reason: 'linear' }], { dictionary: dict, examples });
    expect(out!.example?.term).toBe('负责');
  });

  it('falls back to the fewest collisions when every term collides', () => {
    // Both of 他's terms collide; 他们 collides with one answer, 他人 with two.
    const [out] = enrich([{ char: '他', reason: 'linear' }], {
      dictionary: dict, examples, avoid: new Set(['他', '们', '人', '另']),
    });
    expect(out!.example?.term).toBe('他们');
  });

  it('still offers an example rather than none when everything collides', () => {
    const [out] = enrich([{ char: '负', reason: 'linear' }], {
      dictionary: dict, examples, avoid: new Set(['负', '责', '担']),
    });
    expect(out!.example).toBeDefined();
  });

  // A word already being studied is the better cue, but not at the price of naming another
  // row's answer — an ambiguous cue manufactures a failure, a generic one merely weakens.
  it('prefers a clean term over a studied one that collides', () => {
    const [out] = enrich([{ char: '负', reason: 'linear' }], {
      dictionary: dict, examples, knownWords: ['负责'], avoid: new Set(['负', '责']),
    });
    expect(out!.example?.term).toBe('负担');
  });

  it('still prefers a studied word among terms that all avoid the answers', () => {
    const [out] = enrich([{ char: '负', reason: 'linear' }], {
      dictionary: dict, examples, knownWords: ['负担'], avoid: new Set(['负']),
    });
    expect(out!.example?.term).toBe('负担');
  });
});
