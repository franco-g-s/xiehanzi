/**
 * Turns bare characters into everything a practice row needs to show: pinyin, meaning,
 * stroke count and an example term.
 *
 * Separate from rendering on purpose — the renderer takes a fully-resolved plan and does
 * no lookups, so it can be tested without the dictionary or the stroke dataset.
 */

import type { Dictionary } from '../dict/cedict.js';
import type { Glossary } from '../sources/glossary.js';
import { loadGlyph } from '../render/glyph.js';

export type SelectionReason = 'manual' | 'new' | 'class' | 'hard' | 'linear' | 'relearn';

export type CharacterInput = {
  char: string;
  sourceWord?: string;
  reason: SelectionReason;
};

export type Example = {
  term: string;
  pinyin: string;
  /**
   * The same reading, one entry per syllable, when the dictionary had the term.
   *
   * The recall cue emboldens the syllable belonging to the character it is blanking, which
   * the joined `pinyin` cannot say the boundaries of. Optional because a graded word absent
   * from CC-CEDICT still gets shown, with no reading at all.
   */
  syllables?: readonly string[];
  meaning: string;
};

export type CharacterPlan = {
  char: string;
  pinyin: string;
  meaning: string;
  strokeCount: number;
  sourceWord?: string;
  example?: Example;
  reason: SelectionReason;
};

/** A term that may be shown as an example, with how advanced it is. */
export type ExampleCandidate = { term: string; level: number };

/** character → candidate terms containing it, best first. */
export type ExampleIndex = ReadonlyMap<string, readonly ExampleCandidate[]>;

/** Longer terms don't fit under a row, and single characters aren't examples. */
const MIN_TERM = 2;
const MAX_TERM = 4;
/** Two readings is informative; more is noise on a practice sheet. */
const MAX_READINGS = 2;

/**
 * Builds the character → example-term index once, so enriching a sheet is cheap.
 *
 * Candidates should come from a graded vocabulary list, not a dictionary. 我人 and 这不 are
 * both real CC-CEDICT entries built from very common characters, and both are things nobody
 * says — scoring dictionary entries by character frequency picks exactly those.
 *
 * Within a character's bucket, an easier word wins, then a shorter one.
 */
export function createExampleIndex(
  candidates: Iterable<ExampleCandidate>,
): ExampleIndex {
  const index = new Map<string, ExampleCandidate[]>();

  for (const candidate of candidates) {
    const { term } = candidate;
    if (term.length < MIN_TERM || term.length > MAX_TERM) continue;
    for (const char of new Set(term)) {
      const bucket = index.get(char);
      if (bucket === undefined) index.set(char, [candidate]);
      else bucket.push(candidate);
    }
  }

  for (const bucket of index.values()) {
    bucket.sort((a, b) => a.level - b.level || a.term.length - b.term.length);
  }
  return index;
}

export type EnrichOptions = {
  dictionary: Dictionary;
  examples?: ExampleIndex;
  /** Words already being studied. Preferred over a dictionary pick — more useful to see. */
  knownWords?: Iterable<string>;
  /**
   * Franco's own definitions, from his Anki deck. Consulted before CC-CEDICT for both a
   * character's gloss and its example word's — see `../sources/glossary.js` for why. Only
   * the definition; the pinyin stays CC-CEDICT's, because the cue needs it split into
   * syllables and only the numbered form can be split.
   */
  glossary?: Glossary;
  /**
   * Every answer on the sheet. An example word is preferred if it contains none of them
   * apart from the row's own character, which it must contain.
   *
   * Characters due the same day come off the same drill sheet, so their HSK example words
   * overlap constantly: 负 and 责 both lead to 负责, and with every answer blanked both rows
   * print "＿＿ fùzé" — two rows, one cue, and grading maps a row to the character the
   * manifest recorded for it, so writing the pair in the other order fails both. `buildCues`
   * catches that and drops back to the bare character; this makes that fallback rare instead
   * of routine, by not choosing the colliding word to begin with.
   *
   * Recall only. A drill row prints its own model character, so overlap there gives nothing
   * away — see cli.ts, which passes this on the recall path alone.
   */
  avoid?: ReadonlySet<string>;
};

/** Space on a row is finite; a gloss that overruns pushes the stroke filmstrip off. */
const MAX_GLOSS = 42;

/**
 * CC-CEDICT lists surnames, variants and abbreviations as ordinary entries, and for some
 * very common characters one of those comes first: 和 leads with "old variant of 和", 国
 * with "surname Guo". Taking entry zero blindly puts that nonsense on the sheet for exactly
 * the characters you most need to learn.
 */
const META_GLOSS = /^\s*(surname\b|old variant\b|variant\b|see \b|abbr\b|used in\b)/i;

const isMeta = (entry: { definitions: string[] }): boolean =>
  META_GLOSS.test(entry.definitions[0] ?? '');

/** Substantive entries first, original order otherwise. */
function preferSubstantive<T extends { definitions: string[] }>(entries: readonly T[]): T[] {
  const substantive = entries.filter((e) => !isMeta(e));
  return substantive.length > 0 ? substantive : [...entries];
}

/**
 * CC-CEDICT glosses carry apparatus meant for a dictionary, not a practice sheet:
 * cross-references like `你們|你们[ni3 men5]`, and several senses joined by semicolons.
 * Keep the first sense, drop the apparatus, and cap the length.
 */
export function tidyGloss(gloss: string, max = MAX_GLOSS): string {
  const cleaned = gloss
    .replace(/[\u4e00-\u9fff]+\|[\u4e00-\u9fff]+\[[^\]]*\]/g, '')
    .replace(/\[[a-zA-Z0-9 ]+\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const firstSense = cleaned.split(';')[0]!.trim();
  return fitGloss(firstSense === '' ? cleaned : firstSense, max);
}

/** The length cap on its own, shared by both gloss sources. */
function fitGloss(gloss: string, max = MAX_GLOSS): string {
  if (gloss.length <= max) return gloss;

  // Cutting mid-parenthesis reads as a mistake ("to be (followed by substantive…"), so
  // drop a parenthetical that the cut would leave hanging open.
  let cut = gloss.slice(0, max - 1);
  const openedAt = cut.lastIndexOf('(');
  if (openedAt !== -1 && !cut.slice(openedAt).includes(')')) cut = cut.slice(0, openedAt);
  return `${cut.trimEnd()}…`;
}

/**
 * The gloss to print for a term: Franco's own if he has studied it, CC-CEDICT's otherwise.
 *
 * A studied gloss skips `tidyGloss` apart from the length cap. `tidyGloss` exists to cut a
 * dictionary entry down to one sense out of many and to strip cross-reference apparatus; a
 * hand-written gloss has neither problem, and its semicolons separate senses worth keeping
 * — cutting "old; aged" down to "old" would throw away half of what he actually learned.
 */
function glossOf(
  term: string,
  cedictDefinition: string | undefined,
  glossary: Glossary | undefined,
): string {
  const studied = glossary?.define(term);
  return studied === undefined ? tidyGloss(cedictDefinition ?? '') : fitGloss(studied);
}

function describeTerm(
  dictionary: Dictionary,
  term: string,
  glossary: Glossary | undefined,
): Example | undefined {
  const hit = dictionary.lookup(term)[0];
  if (hit === undefined) return undefined;
  return {
    term,
    pinyin: hit.pinyin,
    syllables: hit.syllables,
    meaning: glossOf(term, hit.definitions[0], glossary),
  };
}


/**
 * The candidates that name the fewest OTHER answers on the sheet — none of them, whenever
 * any such term exists.
 *
 * The row's own character is excluded from the avoid set before counting: the example has
 * to contain it, and it is blanked in the cue anyway.
 *
 * Relative order inside the winning group is untouched, so with nothing to avoid this hands
 * back the candidates exactly as `createExampleIndex` ranked them — easiest, then shortest.
 */
function leastColliding(
  candidates: readonly ExampleCandidate[],
  char: string,
  avoid: ReadonlySet<string> | undefined,
): readonly ExampleCandidate[] {
  if (avoid === undefined || avoid.size === 0) return candidates;

  const collisions = (term: string): number =>
    [...term].filter((c) => c !== char && avoid.has(c)).length;

  let fewest = Infinity;
  for (const candidate of candidates) fewest = Math.min(fewest, collisions(candidate.term));
  return candidates.filter((candidate) => collisions(candidate.term) === fewest);
}

function pickExample(
  char: string,
  sourceWord: string | undefined,
  options: EnrichOptions,
  known: ReadonlySet<string>,
): Example | undefined {
  // 1. The word it actually came from — the most meaningful context there is.
  if (sourceWord !== undefined && sourceWord.length >= MIN_TERM) {
    const described = describeTerm(options.dictionary, sourceWord, options.glossary);
    if (described !== undefined) return described;
    // Not in the dictionary (many class phrases aren't) — still worth showing.
    return { term: sourceWord, pinyin: '', meaning: '' };
  }

  // Narrowed BEFORE the studied-word preference below, not after: a studied word is the
  // better cue, but not at the price of naming another row's answer. An ambiguous cue
  // manufactures a failure; a merely generic one only weakens the prompt.
  const candidates = leastColliding(options.examples?.get(char) ?? [], char, options.avoid);

  // 2. Something already being studied beats a generic pick.
  for (const { term } of candidates) {
    if (known.has(term)) {
      const described = describeTerm(options.dictionary, term, options.glossary);
      if (described !== undefined) return described;
    }
  }

  // 3. Otherwise the easiest, shortest graded word available.
  for (const { term } of candidates) {
    const described = describeTerm(options.dictionary, term, options.glossary);
    if (described !== undefined) return described;
  }

  // The term may be graded but absent from CC-CEDICT; still worth showing.
  const first = candidates[0];
  return first === undefined ? undefined : { term: first.term, pinyin: '', meaning: '' };
}

export function enrich(
  chars: readonly CharacterInput[],
  options: EnrichOptions,
): CharacterPlan[] {
  const known = new Set(options.knownWords ?? []);

  return chars.map((input) => {
    const entries = preferSubstantive(options.dictionary.lookup(input.char));
    const readings = [...new Set(entries.map((e) => e.pinyin))].slice(0, MAX_READINGS);
    const glyph = loadGlyph(input.char);
    const example = pickExample(input.char, input.sourceWord, options, known);

    return {
      char: input.char,
      pinyin: readings.join(' / '),
      meaning: glossOf(input.char, entries[0]?.definitions[0], options.glossary),
      strokeCount: glyph?.strokes.length ?? 0,
      ...(input.sourceWord === undefined ? {} : { sourceWord: input.sourceWord }),
      ...(example === undefined ? {} : { example }),
      reason: input.reason,
    };
  });
}
