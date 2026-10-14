/**
 * CC-CEDICT parsing and lookup.
 *
 * Purpose is verification, not authoring. The agent writes the pinyin and meaning that go
 * onto a card; this exists so it can check itself against a real dictionary first, rather
 * than trusting its own recall.
 *
 * Data: CC-CEDICT, CC BY-SA 4.0 — see data/README.md for attribution.
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { toneMarks } from './pinyin.js';

export type CedictEntry = {
  traditional: string;
  simplified: string;
  /** The raw CEDICT reading, e.g. `su4 liao4`. */
  reading: string;
  /** Tone-marked form, e.g. `sùliào`. */
  pinyin: string;
  /**
   * The same reading, one entry per syllable: `['sù', 'liào']`.
   *
   * Carried alongside the joined form rather than derived on demand, because a cue has to
   * embolden the syllable belonging to the character it is blanking, and the numbered
   * reading is the only form that can be split — once joined, `sùliào` no longer says where
   * one syllable ends.
   */
  syllables: string[];
  definitions: string[];
};

/** `Traditional Simplified [pin1 yin1] /def one/def two/` */
const ENTRY = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s+\/(.*)\/\s*$/;

/** Returns null for comments, blanks and anything that doesn't match the format. */
export function parseCedictLine(line: string): CedictEntry | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  const match = ENTRY.exec(trimmed);
  if (match === null) return null;

  const [, traditional, simplified, reading, defs] = match as unknown as [
    string, string, string, string, string,
  ];

  const syllables = toneMarks(reading, { join: false });

  return {
    traditional,
    simplified,
    reading,
    pinyin: syllables.join(''),
    syllables,
    definitions: defs.split('/').filter((d) => d !== ''),
  };
}

export function parseCedict(text: string): CedictEntry[] {
  const entries: CedictEntry[] = [];
  for (const line of text.split('\n')) {
    const entry = parseCedictLine(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

export type Dictionary = {
  /** Every entry for a term, in file order. Homographs (了 le / liǎo) all come back. */
  lookup(term: string): CedictEntry[];
  /** Every entry, for building secondary indexes. */
  entries(): readonly CedictEntry[];
  size: number;
};

export function createDictionary(entries: readonly CedictEntry[]): Dictionary {
  const index = new Map<string, CedictEntry[]>();

  const add = (key: string, entry: CedictEntry): void => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [entry]);
    else if (!bucket.includes(entry)) bucket.push(entry);
  };

  for (const entry of entries) {
    add(entry.simplified, entry);
    add(entry.traditional, entry);
  }

  return {
    lookup: (term) => index.get(term) ?? [],
    entries: () => entries,
    size: entries.length,
  };
}

/** Loads the vendored gzipped CC-CEDICT. Parsing ~125k entries takes a few hundred ms. */
export function loadDictionary(path: string): Dictionary {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return createDictionary(parseCedict(text));
}
