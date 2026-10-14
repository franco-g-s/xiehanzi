/**
 * Franco's own definitions, extracted from the Anki deck he studies.
 *
 * CC-CEDICT is a dictionary: it lists the first *substantive* sense, which is routinely not
 * the sense anyone learns first. Off real sheets: 着 came out as "a move in chess (Taiwan
 * pr.)", 回 as "Hui ethnic group (Chinese Muslims)", 老 as "prefix used before the surname
 * of a person", 西 as "Xi / xī · the West". Every one is correct and none of them is what
 * the character means to the person being tested on it. The Anki deck already holds the
 * gloss he actually studied, so that is the one the cue should print.
 *
 * The extract is COMMITTED rather than pulled at generation time. Two reasons, both about
 * reproducibility: the machine that runs the scheduled job need not have Anki on it at all, and
 * `push` distinguishes an unchanged sheet from one that has been written on by comparing
 * bytes — so the same date must render identically on both machines. `xiehanzi glossary`
 * refreshes the file deliberately; nothing refreshes it as a side effect.
 *
 * Only the DEFINITION is taken from here. The pinyin stays CC-CEDICT's, because the cue
 * needs the reading split into syllables (to bold the one belonging to the blanked
 * character) and only CEDICT's numbered form can be split — Anki's is already joined.
 */

import { readFileSync } from 'node:fs';
import type { AnkiClient } from './ankiconnect.js';

export type GlossaryEntry = { definition: string; pinyin: string };

/** The committed file's shape. */
export type GlossaryFile = {
  version: 1;
  deck: string;
  entries: Record<string, GlossaryEntry>;
};

export type Glossary = {
  /** Franco's own gloss for a term, or undefined when the deck has never taught it. */
  define(term: string): string | undefined;
  size: number;
};

export function createGlossary(entries: Readonly<Record<string, GlossaryEntry>>): Glossary {
  return {
    define(term) {
      // A blank Definition field is Anki saying nothing, not saying "". Reporting it as a
      // hit would print an empty gloss over a perfectly good CC-CEDICT one.
      const definition = entries[term]?.definition.trim();
      return definition === undefined || definition === '' ? undefined : definition;
    },
    size: Object.keys(entries).length,
  };
}

/** What every caller gets when there is no usable file: a glossary that knows nothing. */
export const EMPTY_GLOSSARY: Glossary = createGlossary({});

function isGlossaryFile(value: unknown): value is GlossaryFile {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  return typeof entries === 'object' && entries !== null;
}

/** Throws on anything that is not a glossary — `loadGlossary` is the forgiving entry point. */
export function parseGlossary(text: string): Glossary {
  const parsed: unknown = JSON.parse(text);
  if (!isGlossaryFile(parsed)) throw new Error('not a glossary file: no entries object');
  return createGlossary(parsed.entries);
}

/**
 * CRITICAL: this never throws. The glossary improves a cue; the sheet IS the product. A
 * file that is missing (a fresh clone before the first `xiehanzi glossary`), truncated, or
 * unreadable must cost Franco a worse gloss for the day, never his morning practice — so
 * every failure degrades to "no glossary" and the CC-CEDICT path takes over unchanged.
 */
export function loadGlossary(path: string): Glossary {
  try {
    return parseGlossary(readFileSync(path, 'utf8'));
  } catch {
    return EMPTY_GLOSSARY;
  }
}

/**
 * Anki stores every field as HTML. A term edited in the browser silently picks up `<div>`,
 * `<br>` and `&nbsp;`, which would otherwise be printed literally onto the sheet.
 */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

type NoteInfo = { fields: Record<string, { value: string }> };

/**
 * How many notes to ask for at once. `notesInfo` returns every field of every note, so the
 * whole 11,000-note deck in one reply is megabytes of JSON through a localhost HTTP call
 * that has a timeout on it.
 */
const BATCH = 500;

/** Field names on the HSK note type. */
const TERM_FIELD = 'Hanzi';
const DEFINITION_FIELD = 'Definition';
const PINYIN_FIELD = 'Pinyin';

/**
 * Reads a whole deck out of Anki into the committed file's shape.
 *
 * Errors are deliberately NOT swallowed here — unlike `loadGlossary`, this is the explicit
 * refresh command, and an unreachable Anki has to be reported rather than quietly writing
 * an empty deck over a good file.
 */
export async function fetchGlossary(anki: AnkiClient, deck: string): Promise<GlossaryFile> {
  const noteIds = await anki.findNotes(`deck:"${deck}"`);
  const entries: Record<string, GlossaryEntry> = {};

  for (let i = 0; i < noteIds.length; i += BATCH) {
    const notes = await anki.invoke<NoteInfo[]>('notesInfo', {
      notes: noteIds.slice(i, i + BATCH),
    });
    for (const note of notes) {
      const term = plainText(note.fields[TERM_FIELD]?.value ?? '');
      const definition = plainText(note.fields[DEFINITION_FIELD]?.value ?? '');
      // A note with no term indexes nothing, and one with no definition is exactly the
      // case `define` already refuses to answer — storing either only bloats the file.
      if (term === '' || definition === '') continue;
      entries[term] = { definition, pinyin: plainText(note.fields[PINYIN_FIELD]?.value ?? '') };
    }
  }

  return { version: 1, deck, entries };
}

/**
 * Sorted by term and pretty-printed, so a refresh that changed three definitions shows as
 * three lines in `git diff` rather than as a reordered 11,000-entry file.
 */
export function serialiseGlossary(file: GlossaryFile): string {
  const entries: Record<string, GlossaryEntry> = {};
  for (const term of Object.keys(file.entries).sort()) entries[term] = file.entries[term]!;
  return `${JSON.stringify({ version: file.version, deck: file.deck, entries }, null, 2)}\n`;
}

/** Terms added, removed, or whose definition or pinyin moved. */
export function countChanged(
  before: Readonly<Record<string, GlossaryEntry>>,
  after: Readonly<Record<string, GlossaryEntry>>,
): number {
  let changed = 0;
  for (const term of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[term];
    const b = after[term];
    if (a?.definition !== b?.definition || a?.pinyin !== b?.pinyin) changed += 1;
  }
  return changed;
}
