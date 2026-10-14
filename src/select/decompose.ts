/**
 * Word → character decomposition.
 *
 * The sheets drill individual hanzi, but every upstream source (Anki, class notes)
 * deals in words. This is the seam between the two.
 */

export type DecomposedChar = {
  /** A single hanzi. */
  char: string;
  /** The word it was first seen in — printed on the sheet as context. */
  sourceWord: string;
};

export type DecomposeOptions = {
  /** Characters too trivial to drill. Hardcoded, never derived from Anki maturity. */
  skip?: Iterable<string>;
};

/**
 * `Unified_Ideograph` rather than `Script=Han`: the latter also matches the iteration
 * mark 々 and the ideographic zero 〇, neither of which is a character you practise.
 * Covers every extension plane, so nothing is lost by being precise here.
 */
const UNIFIED_IDEOGRAPH = /\p{Unified_Ideograph}/u;

/** True for exactly one hanzi. Punctuation, latin, digits and multi-character input are false. */
export function isHanzi(char: string): boolean {
  return [...char].length === 1 && UNIFIED_IDEOGRAPH.test(char);
}

/**
 * Flattens words into the unique hanzi they contain, in first-seen order.
 *
 * Iterates by code point, so ideographs outside the BMP survive intact rather than
 * being torn into surrogate halves.
 */
export function decompose(
  words: Iterable<string>,
  options: DecomposeOptions = {},
): DecomposedChar[] {
  const skip = new Set(options.skip ?? []);
  const seen = new Set<string>();
  const out: DecomposedChar[] = [];

  for (const word of words) {
    for (const char of word) {
      if (!isHanzi(char) || skip.has(char) || seen.has(char)) continue;
      seen.add(char);
      out.push({ char, sourceWord: word });
    }
  }

  return out;
}
