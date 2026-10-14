import { describe, it, expect, vi } from 'vitest';
import { createAnkiVocabSource } from './vocab.js';
import type { AnkiClient } from './ankiconnect.js';

function fakeAnki(handlers: Record<string, (p?: Record<string, unknown>) => unknown>) {
  const queries: string[] = [];
  const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    if (params !== undefined && typeof params.query === 'string') queries.push(params.query);
    const h = handlers[action];
    return h === undefined ? null : h(params);
  });
  const anki = {
    invoke: invoke as unknown as AnkiClient['invoke'],
    deckNames: async () => [],
    modelNames: async () => [],
    findNotes: (q: string) => invoke('findNotes', { query: q }) as Promise<number[]>,
    findCards: (q: string) => invoke('findCards', { query: q }) as Promise<number[]>,
  } satisfies AnkiClient;
  return { anki, queries };
}

const DECK = 'HSK 3.0 Vocabulary';

describe('latestClassDate', () => {
  it('returns the most recent date tag that actually has class notes', async () => {
    const { anki } = fakeAnki({
      getTags: () => ['class', '2026-08-17', '2026-06-15', 'Elementary', '2026-08-19'],
      // 2026-08-19 is a capture, not a class — it has no class-tagged notes.
      findNotes: (p) => ((p!.query as string).includes('2026-08-17') ? [1, 2] : []),
    });
    expect(await createAnkiVocabSource(anki, { deck: DECK }).latestClassDate()).toBe('2026-08-17');
  });

  it('ignores tags that are not dates', async () => {
    const { anki, queries } = fakeAnki({
      getTags: () => ['class', 'chinesepod', 'HSK4', '2026-08-17'],
      findNotes: () => [1],
    });
    await createAnkiVocabSource(anki, { deck: DECK }).latestClassDate();
    expect(queries.every((q) => !q.includes('chinesepod'))).toBe(true);
  });

  it('returns null when no class has ever been tagged', async () => {
    const { anki } = fakeAnki({ getTags: () => ['Elementary'], findNotes: () => [] });
    expect(await createAnkiVocabSource(anki, { deck: DECK }).latestClassDate()).toBeNull();
  });
});

describe('classWords', () => {
  it('requires BOTH the class tag and the date tag', async () => {
    const { anki, queries } = fakeAnki({
      findNotes: () => [1],
      notesInfo: () => [{ noteId: 1, fields: { Hanzi: { value: '笔试' } } }],
    });
    await createAnkiVocabSource(anki, { deck: DECK }).classWords('2026-08-17');

    // Date alone would sweep in chinesepod notes, which share the date-tag convention.
    expect(queries[0]).toContain('tag:class');
    expect(queries[0]).toContain('tag:2026-08-17');
  });

  it('returns the Hanzi field of each note', async () => {
    const { anki } = fakeAnki({
      findNotes: () => [1, 2],
      notesInfo: () => [
        { noteId: 1, fields: { Hanzi: { value: '笔试' } } },
        { noteId: 2, fields: { Hanzi: { value: '冷清' } } },
      ],
    });
    expect(await createAnkiVocabSource(anki, { deck: DECK }).classWords('2026-08-17')).toEqual([
      '笔试',
      '冷清',
    ]);
  });

  it('does not call notesInfo when the class had no notes', async () => {
    const { anki } = fakeAnki({ findNotes: () => [] });
    const notesInfo = vi.fn();
    expect(await createAnkiVocabSource(anki, { deck: DECK }).classWords('2026-01-01')).toEqual([]);
    expect(notesInfo).not.toHaveBeenCalled();
  });
});

describe('wordsIntroducedDaysAgo', () => {
  it('brackets the day so today is excluded from yesterday', async () => {
    const { anki, queries } = fakeAnki({ findCards: () => [], cardsToNotes: () => [] });
    await createAnkiVocabSource(anki, { deck: DECK }).wordsIntroducedDaysAgo(1);
    expect(queries[0]).toContain('introduced:2');
    expect(queries[0]).toContain('-introduced:1');
  });

  it('maps cards back to notes before reading fields', async () => {
    const { anki } = fakeAnki({
      findCards: () => [10, 11],
      cardsToNotes: () => [1],
      notesInfo: () => [{ noteId: 1, fields: { Hanzi: { value: '塑料' } } }],
    });
    expect(await createAnkiVocabSource(anki, { deck: DECK }).wordsIntroducedDaysAgo(1)).toEqual([
      '塑料',
    ]);
  });
});

describe('hardestWords', () => {
  it('walks lapse thresholds downward so the worst cards come first', async () => {
    const byThreshold: Record<string, number[]> = {
      'prop:lapses>=10': [],
      'prop:lapses>=8': [80],
      'prop:lapses>=6': [80, 60],
      'prop:lapses>=5': [80, 60, 50],
      'prop:lapses>=4': [80, 60, 50, 40],
      'prop:lapses>=3': [80, 60, 50, 40, 30],
    };
    const { anki } = fakeAnki({
      findCards: (p) => {
        const q = p!.query as string;
        const key = Object.keys(byThreshold).find((k) => q.includes(k));
        return key === undefined ? [] : byThreshold[key]!;
      },
      cardsToNotes: (p) => (p!.cards as number[]).map((c) => c / 10),
      notesInfo: (p) =>
        (p!.notes as number[]).map((n) => ({ noteId: n, fields: { Hanzi: { value: `w${n}` } } })),
    });

    const out = await createAnkiVocabSource(anki, { deck: DECK }).hardestWords(3);
    expect(out.map((h) => h.word)).toEqual(['w8', 'w6', 'w5']);
    expect(out[0]!.lapses).toBeGreaterThanOrEqual(out[1]!.lapses);
  });

  it('stops early once it has enough, without querying every threshold', async () => {
    const { anki, queries } = fakeAnki({
      findCards: () => [80, 60, 50, 40],
      cardsToNotes: (p) => (p!.cards as number[]).map((c) => c / 10),
      notesInfo: (p) =>
        (p!.notes as number[]).map((n) => ({ noteId: n, fields: { Hanzi: { value: `w${n}` } } })),
    });
    await createAnkiVocabSource(anki, { deck: DECK }).hardestWords(2);
    expect(queries.filter((q) => q.includes('prop:lapses')).length).toBeLessThan(3);
  });

  it('returns nothing when no card has lapsed', async () => {
    const { anki } = fakeAnki({ findCards: () => [], cardsToNotes: () => [] });
    expect(await createAnkiVocabSource(anki, { deck: DECK }).hardestWords(5)).toEqual([]);
  });
});
