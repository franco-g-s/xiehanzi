import { describe, it, expect, vi } from 'vitest';
import { learn, BackupFailedError, BucketMismatchError } from './learn.js';
import type { LearnDeps, LearnInput } from './learn.js';
import type { AnkiClient } from '../sources/ankiconnect.js';
import { createDictionary, parseCedict } from '../dict/cedict.js';

type Call = { action: string; params?: Record<string, unknown> };

/** Fake AnkiConnect that records every call and lets each action be scripted. */
function fakeAnki(script: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const invoke = vi.fn(async (action: string, params?: Record<string, unknown>) => {
    calls.push({ action, ...(params === undefined ? {} : { params }) });
    const scripted = script[action];
    if (scripted instanceof Error) throw scripted;
    if (typeof scripted === 'function') return (scripted as (p?: unknown) => unknown)(params);
    return scripted ?? null;
  });
  const anki = {
    // The recorder returns Promise<unknown>; AnkiClient.invoke is generic. The fake can't
    // honour that soundly, and doesn't need to.
    invoke: invoke as unknown as AnkiClient['invoke'],
    deckNames: async () => [],
    modelNames: async () => [],
    findNotes: async (query: string) => invoke('findNotes', { query }) as Promise<number[]>,
    findCards: async (query: string) => invoke('findCards', { query }) as Promise<number[]>,
  } satisfies AnkiClient;
  const actions = () => calls.map((c) => c.action);
  const find = (action: string) => calls.filter((c) => c.action === action);
  return { anki, calls, actions, find };
}

const DICT = createDictionary(parseCedict('塑料 塑料 [su4 liao4] /plastic/'));

const INPUT: LearnInput = {
  term: '塑料',
  pinyin: 'sùliào',
  meaning: 'plastic',
  sentence: '为了保护环境，我们应该少用<b>塑料</b>。',
  translation: 'To protect the environment, we should use less plastic.',
  emoji: '🧴',
};

/** An existing note whose single card is in the given bucket. */
function existingCard(bucket: 'new' | 'learning' | 'review') {
  return {
    findNotes: [111],
    notesInfo: [{ noteId: 111, cards: [222] }],
    findCards: (p?: unknown) => {
      const query = (p as { query: string }).query;
      const asked = query.includes('-is:new -is:learn')
        ? 'review'
        : query.includes('is:learn')
          ? 'learning'
          : 'new';
      return asked === bucket ? [222] : [];
    },
    addTags: null,
    answerCards: [true],
    setDueDate: true,
    sync: null,
  };
}

function deps(anki: AnkiClient, over: Partial<LearnDeps> = {}): LearnDeps {
  return {
    anki,
    backup: vi.fn(async () => ({ ok: true })),
    dictionary: DICT,
    enqueue: vi.fn(async () => {}),
    now: () => new Date('2026-08-19T12:00:00'),
    ...over,
  };
}

describe('learn — backup gate', () => {
  it('backs up before touching anything', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const backup = vi.fn(async () => ({ ok: true }));
    await learn(INPUT, deps(anki, { backup }));
    expect(backup).toHaveBeenCalledOnce();
    expect(actions().length).toBeGreaterThan(0);
  });

  it('aborts with NO writes when the backup fails', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const backup = vi.fn(async () => {
      throw new Error('daemon down');
    });

    await expect(learn(INPUT, deps(anki, { backup }))).rejects.toThrow(BackupFailedError);

    for (const mutating of ['addNote', 'answerCards', 'setDueDate', 'addTags', 'sync']) {
      expect(actions(), `${mutating} must not run`).not.toContain(mutating);
    }
  });

  it('skips the backup entirely on a dry run', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const backup = vi.fn(async () => ({ ok: true }));
    await learn(INPUT, deps(anki, { backup }), { dryRun: true });
    expect(backup).not.toHaveBeenCalled();
    expect(actions()).not.toContain('setDueDate');
  });
});

describe('learn — scheduling branches on queue state, never on existence', () => {
  it('answers a NEW card and never sets its due date', async () => {
    const { anki, actions, find } = fakeAnki(existingCard('new'));
    const result = await learn(INPUT, deps(anki));

    expect(result.bucket).toBe('new');
    expect(result.action).toBe('answerCards');
    expect(find('answerCards')[0]!.params).toEqual({ answers: [{ cardId: 222, ease: 1 }] });
    expect(actions()).not.toContain('setDueDate');
  });

  it('sets due date on a REVIEW card and never answers it', async () => {
    const { anki, actions, find } = fakeAnki(existingCard('review'));
    const result = await learn(INPUT, deps(anki));

    expect(result.bucket).toBe('review');
    expect(result.action).toBe('setDueDate');
    expect(find('setDueDate')[0]!.params).toEqual({ cards: [222], days: '0' });
    expect(actions()).not.toContain('answerCards');
  });

  it('treats a newly created card as NEW, not review', async () => {
    const { anki, actions, find } = fakeAnki({
      findNotes: [],
      addNote: 999,
      notesInfo: [{ noteId: 999, cards: [888] }],
      findCards: (p?: unknown) =>
        (p as { query: string }).query.endsWith('is:new') ? [888] : [],
      addTags: null,
      answerCards: [true],
      sync: null,
    });

    const result = await learn(INPUT, deps(anki));

    expect(result.created).toBe(true);
    expect(result.bucket).toBe('new');
    expect(find('answerCards')[0]!.params).toEqual({ answers: [{ cardId: 888, ease: 1 }] });
    expect(actions()).not.toContain('setDueDate');
  });

  it('leaves a LEARNING card alone — it is already in today\'s session', async () => {
    const { anki, actions } = fakeAnki(existingCard('learning'));
    const result = await learn(INPUT, deps(anki));

    expect(result.bucket).toBe('learning');
    expect(result.action).toBe('none');
    expect(actions()).not.toContain('answerCards');
    expect(actions()).not.toContain('setDueDate');
    // Still tagged and enqueued, though — capture did happen.
    expect(actions()).toContain('addTags');
  });

  it('refuses to guess when the buckets do not account for every card', async () => {
    const { anki, actions } = fakeAnki({
      findNotes: [111],
      notesInfo: [{ noteId: 111, cards: [222] }],
      findCards: [], // neither bucket claims card 222
    });

    await expect(learn(INPUT, deps(anki))).rejects.toThrow(BucketMismatchError);
    expect(actions()).not.toContain('answerCards');
    expect(actions()).not.toContain('setDueDate');
  });
});

describe('learn — deck targeting', () => {
  it('searches the HSK deck by default', async () => {
    const { anki, find } = fakeAnki(existingCard('review'));
    await learn(INPUT, deps(anki));
    expect(find('findNotes')[0]!.params).toEqual({
      query: 'deck:"HSK 3.0 Vocabulary" Hanzi:塑料',
    });
  });

  // Without this, a real end-to-end run can only be done against the live HSK decks.
  it('can be pointed at another deck entirely, for safe live testing', async () => {
    const { anki, find } = fakeAnki(existingCard('review'));
    await learn(INPUT, deps(anki, { searchDeck: 'xiehanzi-test' }));
    expect(find('findNotes')[0]!.params).toEqual({ query: 'deck:"xiehanzi-test" Hanzi:塑料' });
  });
});

describe('learn — note creation', () => {
  it('creates a Basic+ note with the class-note field shape', async () => {
    const { anki, find } = fakeAnki({
      findNotes: [],
      addNote: 999,
      notesInfo: [{ noteId: 999, cards: [888] }],
      findCards: (p?: unknown) => ((p as { query: string }).query.endsWith('is:new') ? [888] : []),
      addTags: null,
      answerCards: [true],
      sync: null,
    });

    await learn(INPUT, deps(anki));
    const note = (find('addNote')[0]!.params as { note: Record<string, unknown> }).note;

    expect(note.modelName).toBe('Basic+');
    expect(note.deckName).toBe('HSK 3.0 Vocabulary::Bands 1-3: Elementary');
    expect(note.fields).toEqual({
      Hanzi: '塑料',
      Pinyin: 'sùliào',
      Definition: 'plastic',
      Emoji: '🧴',
      FrontSentence: '为了保护环境，我们应该少用<b>塑料</b>。',
      Translation: 'To protect the environment, we should use less plastic.',
      HanziAudio: '',
      FrontSentenceAudio: '',
    });
    expect(note.options).toEqual({ allowDuplicate: false, duplicateScope: 'deck' });
  });

  it('honours a deck override', async () => {
    const { anki, find } = fakeAnki({
      findNotes: [],
      addNote: 999,
      notesInfo: [{ noteId: 999, cards: [888] }],
      findCards: (p?: unknown) => ((p as { query: string }).query.endsWith('is:new') ? [888] : []),
      addTags: null,
      answerCards: [true],
      sync: null,
    });

    await learn({ ...INPUT, deck: 'HSK 3.0 Vocabulary::Bands 4-6: Intermediate' }, deps(anki));
    const note = (find('addNote')[0]!.params as { note: { deckName: string } }).note;
    expect(note.deckName).toBe('HSK 3.0 Vocabulary::Bands 4-6: Intermediate');
  });
});

describe('learn — tagging, queue and sync', () => {
  it('tags with capture and the date, leaving band tags alone', async () => {
    const { anki, find } = fakeAnki(existingCard('review'));
    const result = await learn(INPUT, deps(anki));

    expect(find('addTags')[0]!.params).toEqual({ notes: [111], tags: 'capture 2026-08-19' });
    expect(result.tags).toEqual(['capture', '2026-08-19']);
  });

  it('enqueues the decomposed characters', async () => {
    const { anki } = fakeAnki(existingCard('review'));
    const enqueue = vi.fn(async () => {});
    const result = await learn(INPUT, deps(anki, { enqueue }));

    expect(result.enqueuedChars).toEqual(['塑', '料']);
    expect(enqueue).toHaveBeenCalledWith([
      { char: '塑', sourceWord: '塑料' },
      { char: '料', sourceWord: '塑料' },
    ]);
  });

  it('drops skip-list characters before enqueuing', async () => {
    const { anki } = fakeAnki(existingCard('review'));
    const result = await learn({ ...INPUT, term: '一个人' }, deps(anki, { skip: ['一', '人'] }));
    expect(result.enqueuedChars).toEqual(['个']);
  });

  it('syncs to AnkiWeb last', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const result = await learn(INPUT, deps(anki));
    expect(actions().at(-1)).toBe('sync');
    expect(result.synced).toBe(true);
  });

  it('reports a sync failure instead of swallowing it', async () => {
    const { anki } = fakeAnki({ ...existingCard('review'), sync: new Error('AnkiWeb 503') });
    const result = await learn(INPUT, deps(anki));

    // The card work already succeeded, so this must not throw — but it must be visible.
    expect(result.synced).toBe(false);
    expect(result.syncError).toMatch(/AnkiWeb 503/);
  });
});

describe('learn — dictionary cross-check', () => {
  it('confirms agreement with the dictionary', async () => {
    const { anki } = fakeAnki(existingCard('review'));
    const result = await learn(INPUT, deps(anki));
    expect(result.dictionary).toMatchObject({ matched: true, agrees: true, pinyin: 'sùliào' });
  });

  it('flags a pinyin disagreement without blocking the write', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const result = await learn({ ...INPUT, pinyin: 'sùliáo' }, deps(anki));

    expect(result.dictionary).toMatchObject({ matched: true, agrees: false, pinyin: 'sùliào' });
    expect(actions()).toContain('setDueDate'); // still wrote
  });

  it('proceeds when the term is absent from the dictionary', async () => {
    const { anki, actions } = fakeAnki(existingCard('review'));
    const result = await learn({ ...INPUT, term: '付诸实践' }, deps(anki));

    expect(result.dictionary.matched).toBe(false);
    expect(actions()).toContain('setDueDate');
  });
});
