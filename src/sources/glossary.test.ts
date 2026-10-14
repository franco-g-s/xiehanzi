import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGlossary,
  loadGlossary,
  parseGlossary,
  fetchGlossary,
  serialiseGlossary,
  countChanged,
  EMPTY_GLOSSARY,
  type GlossaryFile,
} from './glossary.js';
import type { AnkiClient } from './ankiconnect.js';
import { AnkiUnreachableError } from './ankiconnect.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xiehanzi-glossary-'));
});

const FILE: GlossaryFile = {
  version: 1,
  deck: 'HSK 3.0 Vocabulary',
  entries: {
    着: { definition: 'in process of; (continuous state)', pinyin: 'zhe' },
    城市: { definition: 'City', pinyin: 'chéngshì' },
  },
};

describe('createGlossary', () => {
  it('gives back the definition Franco actually studies', () => {
    expect(createGlossary(FILE.entries).define('着')).toBe('in process of; (continuous state)');
  });

  it('knows nothing about a term that is not in the deck', () => {
    expect(createGlossary(FILE.entries).define('鬃')).toBeUndefined();
  });

  it('looks up multi-character words as well as single characters', () => {
    expect(createGlossary(FILE.entries).define('城市')).toBe('City');
  });

  it('reports how many terms it holds', () => {
    expect(createGlossary(FILE.entries).size).toBe(2);
  });

  // A blank Definition field is Anki saying nothing, not saying "". Treating it as a hit
  // would print an empty gloss where CC-CEDICT had a perfectly good one.
  it('treats an empty definition as no definition at all', () => {
    expect(createGlossary({ 着: { definition: '   ', pinyin: 'zhe' } }).define('着')).toBeUndefined();
  });
});

describe('EMPTY_GLOSSARY', () => {
  it('answers nothing, so callers need no null check', () => {
    expect(EMPTY_GLOSSARY.define('着')).toBeUndefined();
    expect(EMPTY_GLOSSARY.size).toBe(0);
  });
});

describe('parseGlossary', () => {
  it('reads the committed file shape', () => {
    expect(parseGlossary(JSON.stringify(FILE)).define('着')).toContain('in process of');
  });

  it('rejects JSON that is not a glossary rather than pretending it is one', () => {
    expect(() => parseGlossary('{"version":1}')).toThrow();
  });
});

// CRITICAL: the glossary is a nicety; the sheet is the product. A missing or corrupt file
// must cost Franco a worse gloss, never his morning practice.
describe('loadGlossary — degrading rather than throwing', () => {
  it('loads a real file', () => {
    const path = join(dir, 'g.json');
    writeFileSync(path, JSON.stringify(FILE));
    expect(loadGlossary(path).define('城市')).toBe('City');
  });

  it('degrades to an empty glossary when the file is missing', () => {
    expect(loadGlossary(join(dir, 'nope.json')).size).toBe(0);
  });

  it('degrades to an empty glossary when the file is not valid JSON', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json');
    expect(loadGlossary(path).size).toBe(0);
  });

  it('degrades to an empty glossary when the JSON is the wrong shape', () => {
    const path = join(dir, 'wrong.json');
    writeFileSync(path, '{"version":1,"deck":"x"}');
    expect(loadGlossary(path).size).toBe(0);
  });

  // root (e.g. a CI container) ignores file modes, so the file would stay readable.
  it.skipIf(process.getuid?.() === 0)('degrades to an empty glossary when the file cannot be read at all', () => {
    const path = join(dir, 'locked.json');
    writeFileSync(path, JSON.stringify(FILE));
    chmodSync(path, 0o000);
    expect(loadGlossary(path).size).toBe(0);
    chmodSync(path, 0o600);
  });
});

describe('fetchGlossary', () => {
  const notes = [
    { fields: { Hanzi: { value: '着' }, Definition: { value: 'in process of' }, Pinyin: { value: 'zhe' } } },
    { fields: { Hanzi: { value: '城市' }, Definition: { value: 'City' }, Pinyin: { value: 'chéngshì' } } },
  ];

  function fakeAnki(over: Partial<AnkiClient> = {}): AnkiClient {
    return {
      invoke: vi.fn(async (action: string) => (action === 'notesInfo' ? notes : null)),
      deckNames: async () => [],
      modelNames: async () => [],
      findNotes: vi.fn(async () => [1, 2]),
      findCards: async () => [],
      ...over,
    } as unknown as AnkiClient;
  }

  it('reads the deck into the committed file shape', async () => {
    const file = await fetchGlossary(fakeAnki(), 'HSK 3.0 Vocabulary');
    expect(file.version).toBe(1);
    expect(file.deck).toBe('HSK 3.0 Vocabulary');
    expect(file.entries['着']).toEqual({ definition: 'in process of', pinyin: 'zhe' });
  });

  it('searches only the named deck', async () => {
    const anki = fakeAnki();
    await fetchGlossary(anki, 'HSK 3.0 Vocabulary');
    expect(anki.findNotes).toHaveBeenCalledWith('deck:"HSK 3.0 Vocabulary"');
  });

  // Anki stores fields as HTML: a term edited in the browser picks up <div>, <br> and
  // &nbsp; that would otherwise be printed literally onto the sheet.
  it('strips the HTML Anki stores in its fields', async () => {
    const anki = fakeAnki({
      invoke: vi.fn(async () => [
        { fields: { Hanzi: { value: '老' }, Definition: { value: 'old;<br>&nbsp;aged' }, Pinyin: { value: '<b>lǎo</b>' } } },
      ]),
    } as unknown as Partial<AnkiClient>);
    const file = await fetchGlossary(anki, 'D');
    expect(file.entries['老']).toEqual({ definition: 'old; aged', pinyin: 'lǎo' });
  });

  it('skips a note with no term or no definition rather than storing a blank', async () => {
    const anki = fakeAnki({
      invoke: vi.fn(async () => [
        { fields: { Hanzi: { value: '' }, Definition: { value: 'x' }, Pinyin: { value: 'x' } } },
        { fields: { Hanzi: { value: '好' }, Definition: { value: '' }, Pinyin: { value: 'hǎo' } } },
      ]),
    } as unknown as Partial<AnkiClient>);
    expect(Object.keys((await fetchGlossary(anki, 'D')).entries)).toEqual([]);
  });

  it('lets an unreachable Anki surface as itself, not as a silent empty deck', async () => {
    const anki = fakeAnki({
      findNotes: vi.fn(async () => {
        throw new AnkiUnreachableError('Anki is not running');
      }),
    } as unknown as Partial<AnkiClient>);
    await expect(fetchGlossary(anki, 'D')).rejects.toBeInstanceOf(AnkiUnreachableError);
  });

  it('asks for notes in batches, so an 11,000-note deck does not arrive as one reply', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => i + 1);
    const invoke = vi.fn(async (_action: string, params?: Record<string, unknown>) =>
      (params!['notes'] as number[]).map((n) => ({
        fields: { Hanzi: { value: `x${n}` }, Definition: { value: 'd' }, Pinyin: { value: 'p' } },
      })),
    );
    const anki = fakeAnki({ findNotes: vi.fn(async () => many), invoke } as unknown as Partial<AnkiClient>);
    const file = await fetchGlossary(anki, 'D');
    expect(Object.keys(file.entries)).toHaveLength(1200);
    expect(invoke.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('serialiseGlossary', () => {
  it('sorts the terms, so the committed file does not churn on every refresh', () => {
    const text = serialiseGlossary({
      version: 1,
      deck: 'D',
      entries: { 龟: { definition: 'turtle', pinyin: 'guī' }, 一: { definition: 'One', pinyin: 'yī' } },
    });
    expect(text.indexOf('"一"')).toBeLessThan(text.indexOf('"龟"'));
  });

  it('round-trips through parseGlossary', () => {
    expect(parseGlossary(serialiseGlossary(FILE)).define('城市')).toBe('City');
  });

  it('is byte-stable for the same input', () => {
    expect(serialiseGlossary(FILE)).toBe(serialiseGlossary(FILE));
  });
});

describe('countChanged', () => {
  it('counts an added term', () => {
    expect(countChanged({}, FILE.entries)).toBe(2);
  });

  it('counts a changed definition', () => {
    const after = { ...FILE.entries, 城市: { definition: 'town', pinyin: 'chéngshì' } };
    expect(countChanged(FILE.entries, after)).toBe(1);
  });

  it('counts a removed term', () => {
    expect(countChanged(FILE.entries, { 着: FILE.entries['着']! })).toBe(1);
  });

  it('counts nothing when the deck has not moved', () => {
    expect(countChanged(FILE.entries, { ...FILE.entries })).toBe(0);
  });
});
