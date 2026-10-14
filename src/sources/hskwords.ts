/**
 * The HSK 3.0 vocabulary list — 11,092 words graded into levels 1-9.
 *
 * Used to choose the example term shown under each practice row. Picking examples from
 * a dictionary instead produces real but useless words: 我人 and 这不 are both valid
 * CC-CEDICT entries built from very common characters, and both are things nobody says.
 * A graded vocabulary list only contains words worth knowing.
 *
 * Data: data/hsk30-wordlist.txt (MIT, Pleco Inc.).
 */

import { readFileSync } from 'node:fs';

export type HskWord = {
  term: string;
  /** 1-6, or 7 for the combined 七–九级 section. */
  level: number;
};

const SECTIONS: Record<string, number> = {
  '一级词汇表': 1,
  '二级词汇表': 2,
  '三级词汇表': 3,
  '四级词汇表': 4,
  '五级词汇表': 5,
  '六级词汇表': 6,
  '七一九级词汇表': 7,
};

/** `123 词` — a space, not a tab, unlike the character list. */
const ENTRY = /^\d+\s+(.+)$/;

export function parseWordList(text: string): HskWord[] {
  const words: HskWord[] = [];
  const seen = new Set<string>();
  let level: number | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const entry = ENTRY.exec(line);
    if (entry === null) {
      level = SECTIONS[line] ?? level;
      continue;
    }
    if (level === null) continue;

    // `白（形）` carries a part of speech; `爸爸｜爸` lists two accepted forms.
    for (const variant of entry[1]!.split('｜')) {
      const term = variant.replace(/（[^）]*）/g, '').trim();
      if (term === '' || seen.has(term)) continue;
      seen.add(term);
      words.push({ term, level });
    }
  }

  return words;
}

export function loadHskWords(path: string): HskWord[] {
  return parseWordList(readFileSync(path, 'utf8'));
}
