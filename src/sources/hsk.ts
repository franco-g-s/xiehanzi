/**
 * The HSK 3.0 character standard.
 *
 * The standard defines two different things, and the difference is the whole premise of
 * this project:
 *
 *   汉字表    3,000 characters you must RECOGNISE, graded into levels 1-9
 *   手写字表  1,200 characters you must be able to WRITE BY HAND, graded 初等/中等/高等
 *
 * 1,800 characters are recognition-only by design. Handwriting deliberately lags reading,
 * so the bands do not line up: 中等手写 draws most of its characters from reading levels 1-3.
 *
 * Data: data/hsk30-charlist.txt (MIT, Pleco Inc.) and data/char-frequency.txt (ranks
 * derived from Jun Da's frequency list). See data/README.md.
 */

import { readFileSync } from 'node:fs';

export type HandwritingBand = 'elementary' | 'intermediate' | 'advanced';

export type HskChar = {
  char: string;
  /** 1-6, or 7 for the combined 七–九级 section. */
  readingLevel: number;
  /** null when the standard never asks you to write it. */
  handwritingBand: HandwritingBand | null;
  /** Rank in modern usage; 1 is the most frequent. null when unranked. */
  frequencyRank: number | null;
};

const READING_SECTIONS: Record<string, number> = {
  '一级汉字表': 1,
  '二级汉字表': 2,
  '三级汉字表': 3,
  '四级汉字表': 4,
  '五级汉字表': 5,
  '六级汉字表': 6,
  // The OCR renders 七–九级 as 七一九级. One combined section covering levels 7-9.
  '七一九级汉字表': 7,
};

const WRITING_SECTIONS: Record<string, HandwritingBand> = {
  '初等手写字表': 'elementary',
  '中等手写字表': 'intermediate',
  '高等手写字表': 'advanced',
};

const ENTRY = /^\d+\t(.+)$/;

/** One record per character, merging the reading and handwriting taxonomies. */
export function parseCharList(text: string): HskChar[] {
  const byChar = new Map<string, HskChar>();
  let readingLevel: number | null = null;
  let band: HandwritingBand | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '' || line.startsWith('#')) continue;

    const entry = ENTRY.exec(line);
    if (entry === null) {
      readingLevel = READING_SECTIONS[line] ?? null;
      band = WRITING_SECTIONS[line] ?? null;
      continue;
    }

    const char = entry[1]!;
    const existing = byChar.get(char);
    if (existing === undefined) {
      byChar.set(char, {
        char,
        readingLevel: readingLevel ?? 0,
        handwritingBand: band,
        frequencyRank: null,
      });
      continue;
    }
    // Second sighting: the character appears in both taxonomies. Keep whichever fact
    // this section carries without discarding the other.
    if (readingLevel !== null) existing.readingLevel = readingLevel;
    if (band !== null) existing.handwritingBand = band;
  }

  return [...byChar.values()];
}

/** `rank<TAB>character` lines. */
export function parseFrequency(text: string): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const [rank, char] = line.split('\t');
    if (rank === undefined || char === undefined) continue;
    const n = Number(rank);
    if (Number.isInteger(n) && char !== '') ranks.set(char, n);
  }
  return ranks;
}

export type HskCatalogue = {
  all(): HskChar[];
  get(char: string): HskChar | undefined;
  /** Characters in one handwriting band, in the standard's own order. */
  handwriting(band: HandwritingBand): HskChar[];
  /** Characters you must recognise but are never asked to write. */
  readingOnly(): HskChar[];
};

export function createCatalogue(
  chars: readonly HskChar[],
  frequency: ReadonlyMap<string, number>,
): HskCatalogue {
  const withFreq = chars.map((c) => ({ ...c, frequencyRank: frequency.get(c.char) ?? null }));
  const index = new Map(withFreq.map((c) => [c.char, c]));

  return {
    all: () => withFreq,
    get: (char) => index.get(char),
    handwriting: (band) => withFreq.filter((c) => c.handwritingBand === band),
    readingOnly: () => withFreq.filter((c) => c.handwritingBand === null),
  };
}

export function loadHsk(charListPath: string, frequencyPath: string): HskCatalogue {
  return createCatalogue(
    parseCharList(readFileSync(charListPath, 'utf8')),
    parseFrequency(readFileSync(frequencyPath, 'utf8')),
  );
}
