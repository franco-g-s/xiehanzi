/**
 * Vocabulary for double-down review, read entirely from Anki.
 *
 * There is deliberately no notes parser. The notes workflow upstream already writes every
 * class term into Anki tagged `class` + the class date, normalised into fields, with none
 * missing a date tag. Parsing the notes again would mean a second source of truth, brittle
 * table parsing, and a notes-path dependency on whichever machine runs the job. Anki is
 * the canonical store; the notes are its upstream.
 */

import type { AnkiClient } from './ankiconnect.js';

export type HardWord = {
  word: string;
  /** A lower bound, not an exact count — cards are bucketed by threshold. Ordering is exact. */
  lapses: number;
};

export type VocabSourceConfig = {
  /** Top-level deck to search, e.g. `HSK 3.0 Vocabulary`. */
  deck: string;
  /** Field holding the term. */
  field?: string;
};

export type VocabSource = {
  latestClassDate(): Promise<string | null>;
  classWords(date: string): Promise<string[]>;
  wordsIntroducedDaysAgo(days: number): Promise<string[]>;
  hardestWords(limit: number): Promise<HardWord[]>;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Lapse buckets, worst first. Querying thresholds keeps this to a handful of cheap
 * card-ID lookups instead of `cardsInfo`, which returns ~100K characters of template
 * HTML per batch.
 */
const LAPSE_THRESHOLDS = [10, 8, 6, 5, 4, 3] as const;

/** How many date tags to probe before giving up looking for the last class. */
const MAX_DATE_PROBES = 40;

type NoteInfo = { noteId: number; fields: Record<string, { value: string }> };

export function createAnkiVocabSource(
  anki: AnkiClient,
  config: VocabSourceConfig,
): VocabSource {
  const field = config.field ?? 'Hanzi';
  const scope = `deck:"${config.deck}"`;

  async function wordsOf(noteIds: readonly number[]): Promise<string[]> {
    if (noteIds.length === 0) return [];
    const notes = await anki.invoke<NoteInfo[]>('notesInfo', { notes: [...noteIds] });
    return notes.map((n) => n.fields[field]?.value ?? '').filter((w) => w !== '');
  }

  async function notesOfCards(cardIds: readonly number[]): Promise<number[]> {
    if (cardIds.length === 0) return [];
    return anki.invoke<number[]>('cardsToNotes', { cards: [...cardIds] });
  }

  return {
    async latestClassDate() {
      const tags = await anki.invoke<string[]>('getTags');
      const dates = tags.filter((t) => ISO_DATE.test(t)).sort().reverse();

      // A date tag alone is not enough: chinesepod notes use the same convention, and a
      // `capture` from `learn` also stamps today's date.
      for (const date of dates.slice(0, MAX_DATE_PROBES)) {
        const found = await anki.findNotes(`${scope} tag:class tag:${date}`);
        if (found.length > 0) return date;
      }
      return null;
    },

    async classWords(date) {
      return wordsOf(await anki.findNotes(`${scope} tag:class tag:${date}`));
    },

    async wordsIntroducedDaysAgo(days) {
      // `introduced:n` means "within the last n days", so bracket it to get one day.
      const cards = await anki.findCards(
        `${scope} introduced:${days + 1} -introduced:${days}`,
      );
      return wordsOf(await notesOfCards(cards));
    },

    async hardestWords(limit) {
      const seen = new Set<number>();
      const ordered: Array<{ cardId: number; lapses: number }> = [];

      for (const threshold of LAPSE_THRESHOLDS) {
        if (ordered.length >= limit) break;
        const cards = await anki.findCards(`${scope} prop:lapses>=${threshold}`);
        for (const cardId of cards) {
          if (seen.has(cardId)) continue;
          seen.add(cardId);
          ordered.push({ cardId, lapses: threshold });
        }
      }

      const wanted = ordered.slice(0, limit);
      const noteIds = await notesOfCards(wanted.map((c) => c.cardId));
      const words = await wordsOf(noteIds);

      // notesOfCards preserves order, and one card per note here, so these line up.
      return words.map((word, i) => ({ word, lapses: wanted[i]?.lapses ?? 0 }));
    },
  };
}
