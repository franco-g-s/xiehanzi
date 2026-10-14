/**
 * `xiehanzi learn` — capture a term from life into Anki and the writing queue.
 *
 * The only module in this project that mutates the Anki collection. Its scheduling rules
 * are copied from the notes workflow that also writes class terms into these decks, so the
 * two writers never disagree.
 */

import type { AnkiClient } from '../sources/ankiconnect.js';
import type { Dictionary } from '../dict/cedict.js';
import { decompose, type DecomposedChar } from '../select/decompose.js';

export const DEFAULT_DECK = 'HSK 3.0 Vocabulary::Bands 1-3: Elementary';
export const SEARCH_DECK = 'HSK 3.0 Vocabulary';
export const MODEL = 'Basic+';

/** The backup did not succeed, so nothing was written. */
export class BackupFailedError extends Error {
  override name = 'BackupFailedError';
}

/**
 * The new and review buckets didn't account for every card. Guessing here is how a new
 * card ends up forced into the review queue, so we stop instead.
 */
export class BucketMismatchError extends Error {
  override name = 'BucketMismatchError';
}

export type LearnInput = {
  term: string;
  pinyin: string;
  meaning: string;
  sentence?: string;
  translation?: string;
  emoji?: string;
  /** Defaults to the Elementary subdeck. */
  deck?: string;
};

export type LearnDeps = {
  anki: AnkiClient;
  /** Triggers the pre-write backup. Must reject if the backup did not happen. */
  backup: () => Promise<unknown>;
  enqueue: (chars: DecomposedChar[]) => Promise<void> | void;
  dictionary?: Dictionary;
  now?: () => Date;
  skip?: Iterable<string>;
  /** Deck searched for an existing note. Overridable so live runs can target a test deck. */
  searchDeck?: string;
};

export type DictionaryCheck = {
  matched: boolean;
  /** Undefined when the term isn't in the dictionary. */
  agrees?: boolean;
  pinyin?: string;
  definitions?: string[];
};

/**
 * Anki queue states, collapsed to what actually changes our behaviour.
 * `learning` covers queue 1 and 3 — cards partway through their learning steps.
 */
export type Bucket = 'new' | 'learning' | 'review';

export type LearnAction = 'answerCards' | 'setDueDate' | 'none';

export type LearnResult = {
  term: string;
  noteId: number;
  created: boolean;
  bucket: Bucket;
  action: LearnAction;
  tags: string[];
  enqueuedChars: string[];
  dictionary: DictionaryCheck;
  synced: boolean;
  syncError?: string;
  dryRun: boolean;
};

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Compares ignoring spacing and case — `sù liào` and `Sùliào` are the same reading. */
function sameReading(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  return norm(a) === norm(b);
}

function checkDictionary(dict: Dictionary | undefined, input: LearnInput): DictionaryCheck {
  const hits = dict?.lookup(input.term) ?? [];
  const first = hits[0];
  // A miss is expected for many multi-character phrases (付诸实践 is absent from CC-CEDICT).
  // It forgoes the cross-check; it never blocks the write.
  if (first === undefined) return { matched: false };

  return {
    matched: true,
    agrees: hits.some((h) => sameReading(h.pinyin, input.pinyin)),
    pinyin: first.pinyin,
    definitions: first.definitions,
  };
}

export async function learn(
  input: LearnInput,
  deps: LearnDeps,
  options: { dryRun?: boolean } = {},
): Promise<LearnResult> {
  const {
    anki, backup, enqueue, dictionary, now = () => new Date(), skip,
    searchDeck = SEARCH_DECK,
  } = deps;
  const dryRun = options.dryRun ?? false;
  const date = isoDate(now());
  const tags = ['capture', date];

  const dictionaryCheck = checkDictionary(dictionary, input);

  // Step 0 — back up before anything else. A failure here stops the run outright.
  if (!dryRun) {
    try {
      await backup();
    } catch (cause) {
      throw new BackupFailedError(
        'Anki backup failed, so nothing was written. Check the backup service, or set ' +
          'XIEHANZI_ANKI_BACKUP=off to write without one.',
        { cause },
      );
    }
  }

  // Step 1 — find the note.
  const found = await anki.findNotes(`deck:"${searchDeck}" Hanzi:${input.term}`);
  let noteId = found[0];
  const created = noteId === undefined;

  // Step 2 — create it if missing.
  if (noteId === undefined) {
    if (dryRun) {
      return {
        term: input.term,
        noteId: -1,
        created: true,
        bucket: 'new',
        action: 'answerCards',
        tags,
        enqueuedChars: decompose([input.term], skip === undefined ? {} : { skip }).map((d) => d.char),
        dictionary: dictionaryCheck,
        synced: false,
        dryRun,
      };
    }
    noteId = await anki.invoke<number>('addNote', {
      note: {
        deckName: input.deck ?? DEFAULT_DECK,
        modelName: MODEL,
        fields: {
          Hanzi: input.term,
          Pinyin: input.pinyin,
          Definition: input.meaning,
          Emoji: input.emoji ?? '',
          FrontSentence: input.sentence ?? '',
          Translation: input.translation ?? '',
          HanziAudio: '',
          FrontSentenceAudio: '',
        },
        tags,
        options: { allowDuplicate: false, duplicateScope: 'deck' },
      },
    });
  }

  // Step 3 — bucket by queue state. Deliberately uses findCards rather than cardsInfo,
  // which returns ~100K chars of template HTML per batch.
  const notes = await anki.invoke<Array<{ noteId: number; cards: number[] }>>('notesInfo', {
    notes: [noteId],
  });
  const cardIds = notes.flatMap((n) => n.cards);

  const newCards = await anki.findCards(`nid:${noteId} is:new`);
  const learningCards = await anki.findCards(`nid:${noteId} is:learn`);
  const reviewCards = await anki.findCards(`nid:${noteId} -is:new -is:learn`);

  const bucketed = newCards.length + learningCards.length + reviewCards.length;
  if (bucketed !== cardIds.length) {
    throw new BucketMismatchError(
      `Cards for note ${noteId} did not split cleanly: ${cardIds.length} card(s), but ` +
        `${newCards.length} new + ${learningCards.length} learning + ${reviewCards.length} review. ` +
        'Refusing to guess.',
    );
  }

  const bucket: Bucket =
    newCards.length > 0 ? 'new' : learningCards.length > 0 ? 'learning' : 'review';

  // Step 4 — exactly one action, chosen by bucket. Applying the wrong one distorts
  // scheduling in ways that are hard to notice and harder to undo.
  //
  //   new       answerCards ease=1 — logs a real review and moves the card into learning,
  //             bypassing the daily new-card limit. setDueDate here would force it
  //             straight to review with a bogus interval (type:2 queue:2 reps:0).
  //   learning  nothing. The card is already in today's session; setDueDate would
  //             graduate it out of its remaining learning steps early, and answerCards
  //             would restart those steps. Neither is what capture means.
  //   review    setDueDate days=0 — due today without fabricating a review. answerCards
  //             here would record a lapse that never happened and hurt the FSRS history.
  const action: LearnAction =
    bucket === 'new' ? 'answerCards' : bucket === 'review' ? 'setDueDate' : 'none';

  if (!dryRun) {
    if (action === 'answerCards') {
      await anki.invoke('answerCards', {
        answers: newCards.map((cardId) => ({ cardId, ease: 1 })),
      });
    } else if (action === 'setDueDate') {
      await anki.invoke('setDueDate', { cards: reviewCards, days: '0' });
    }
  }

  // Step 5 — tag. Idempotent; band tags are never touched.
  if (!dryRun) await anki.invoke('addTags', { notes: [noteId], tags: tags.join(' ') });

  // Step 6 — writing queue.
  const chars = decompose([input.term], skip === undefined ? {} : { skip });
  if (!dryRun) await enqueue(chars);

  // Step 7 — sync to AnkiWeb so the change reaches the phone. A failure here does not undo
  // the card work, so it is reported rather than thrown.
  let synced = false;
  let syncError: string | undefined;
  if (!dryRun) {
    try {
      await anki.invoke('sync');
      synced = true;
    } catch (cause) {
      syncError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return {
    term: input.term,
    noteId,
    created,
    bucket,
    action,
    tags,
    enqueuedChars: chars.map((c) => c.char),
    dictionary: dictionaryCheck,
    synced,
    ...(syncError === undefined ? {} : { syncError }),
    dryRun,
  };
}
