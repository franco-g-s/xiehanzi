/**
 * CC-CEDICT numbered pinyin → tone marks.
 *
 * CEDICT stores readings as `su4 liao4`; the Anki cards use `sùliào`. The agent supplies
 * the pinyin it writes onto a card, but it can check itself against this.
 */

/** Tone rows indexed 1-4; index 0 is the toneless base. */
const TONES: Record<string, readonly string[]> = {
  a: ['a', 'ā', 'á', 'ǎ', 'à'],
  e: ['e', 'ē', 'é', 'ě', 'è'],
  i: ['i', 'ī', 'í', 'ǐ', 'ì'],
  o: ['o', 'ō', 'ó', 'ǒ', 'ò'],
  u: ['u', 'ū', 'ú', 'ǔ', 'ù'],
  ü: ['ü', 'ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

const VOWELS = 'aeiouü';

/**
 * Where the mark goes: on `a` if present, else `o`, else `e`, else the *last* vowel.
 * That last clause is what makes liu4 → liù and gui4 → guì come out right.
 */
function markIndex(letters: string): number {
  const lower = letters.toLowerCase();
  for (const preferred of ['a', 'o', 'e']) {
    const at = lower.indexOf(preferred);
    if (at !== -1) return at;
  }
  for (let i = lower.length - 1; i >= 0; i -= 1) {
    if (VOWELS.includes(lower[i]!)) return i;
  }
  return -1;
}

/** Converts one CEDICT syllable, e.g. `lu:4` → `lǜ`. Capitalisation is preserved. */
export function syllableToneMarks(syllable: string): string {
  if (syllable === '') return '';

  const match = /^(.*?)([1-5]?)$/.exec(syllable);
  const base = (match?.[1] ?? syllable).replace(/u:/gi, 'ü').replace(/v/gi, 'ü');
  const tone = Number(match?.[2] ?? '') || 0;

  const at = markIndex(base);
  if (at === -1) {
    // Two very different vowel-less cases. The erhua suffix `r5` is a real syllable and
    // its digit is a (neutral) tone, so it goes. The "11" in 11区 is not a syllable at
    // all and its digits are data — hand that token back untouched.
    return /[a-zü]/i.test(base) ? base : syllable;
  }
  // Tone 5 is neutral and 0 means unmarked: both keep the base, minus the digit.
  if (tone === 0 || tone === 5) return base;

  const target = base[at]!;
  const row = TONES[target.toLowerCase()];
  if (row === undefined) return base;

  const marked = row[tone]!;
  return base.slice(0, at) + (target === target.toUpperCase() ? marked.toUpperCase() : marked) + base.slice(at + 1);
}

export type ToneMarksOptions = {
  /** Join syllables into one word (default) or return them separately. */
  join?: boolean;
};

/** Converts a whole CEDICT reading, e.g. `su4 liao4` → `sùliào`. */
export function toneMarks(reading: string, options: { join: false }): string[];
export function toneMarks(reading: string, options?: ToneMarksOptions): string;
export function toneMarks(reading: string, options: ToneMarksOptions = {}): string | string[] {
  const syllables = reading.trim().split(/\s+/).filter(Boolean).map(syllableToneMarks);
  return options.join === false ? syllables : syllables.join('');
}
