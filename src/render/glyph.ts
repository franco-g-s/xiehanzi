/**
 * Character glyphs, drawn from stroke outlines rather than set in a font.
 *
 * The model character, the faded tracing glyphs and the stroke-order filmstrip all come
 * from the same paths, so they are guaranteed to be identical shapes. A font plus a
 * separate stroke diagram cannot promise that, and a mismatch would teach wrong forms.
 *
 * Data: hanzi-writer-data, whose outlines derive from Make Me a Hanzi / Arphic AR PL UKai
 * — already a 楷体. See data/README.md.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The dataset's box. Coordinates run 0-1024 in x, and upward in y from about -124 to 900. */
export const GLYPH_VIEWBOX = '0 0 1024 1024';

/**
 * Breathing room between a model glyph and the walls of the cell it sits in, as a fraction
 * of the cell. The stroke data fills its 1024 box edge to edge, which reads as cramped
 * against a 米字格 border. Applied by widening the viewBox rather than transforming the
 * paths. Shared so the drill's model character and the solutions page's answer glyph are
 * drawn at exactly the same size.
 */
const MODEL_INSET = 0.07;
const GLYPH_BOX = 1024;
const INSET_UNITS = GLYPH_BOX * MODEL_INSET;
export const MODEL_VIEWBOX =
  `${-INSET_UNITS} ${-INSET_UNITS} ${GLYPH_BOX + 2 * INSET_UNITS} ${GLYPH_BOX + 2 * INSET_UNITS}`;

/** Flips the y axis into SVG's downward convention. */
export const GLYPH_TRANSFORM = 'translate(0, 900) scale(1, -1)';

export type Glyph = {
  char: string;
  /** One SVG path per stroke, in writing order. */
  strokes: string[];
  medians: number[][][];
};

export type PathOptions = {
  fill: string;
  /** Omitted from the output when 1. */
  opacity?: number;
  /** Render only the first n strokes. */
  upTo?: number;
};

export type FilmstripOptions = {
  sizeMm: number;
  /** Beyond this, frames are dropped from the end rather than overrunning the row. */
  maxFrames?: number;
  newStrokeFill?: string;
  priorStrokeFill?: string;
};

const SINGLE_HANZI = /^\p{Unified_Ideograph}$/u;

/**
 * Loads one character's stroke data, or null if the dataset doesn't have it.
 *
 * Input is checked to be exactly one ideograph before it reaches `require`, so a stray
 * string can never be resolved as a module path.
 */
export function loadGlyph(char: string): Glyph | null {
  if (!SINGLE_HANZI.test(char)) return null;
  try {
    const data = require(`hanzi-writer-data/${char}.json`) as {
      strokes: string[];
      medians: number[][][];
    };
    return { char, strokes: data.strokes, medians: data.medians };
  } catch {
    return null;
  }
}

/** The `<path>` elements for a glyph. Caller supplies the surrounding `<svg>` and `<g>`. */
export function glyphPaths(glyph: Glyph, options: PathOptions): string {
  const strokes =
    options.upTo === undefined ? glyph.strokes : glyph.strokes.slice(0, options.upTo);
  const opacity =
    options.opacity === undefined || options.opacity >= 1 ? '' : ` opacity="${options.opacity}"`;

  return strokes
    .map((d) => `<path d="${d}" fill="${options.fill}"${opacity}/>`)
    .join('');
}

/** Wraps paths in a correctly sized, correctly oriented `<svg>`. */
export function glyphSvg(
  glyph: Glyph,
  options: PathOptions & { sizeMm: number; className?: string },
): string {
  const cls = options.className === undefined ? '' : ` class="${options.className}"`;
  return (
    `<svg${cls} width="${options.sizeMm}mm" height="${options.sizeMm}mm" viewBox="${GLYPH_VIEWBOX}">` +
    `<g transform="${GLYPH_TRANSFORM}">${glyphPaths(glyph, options)}</g>` +
    `</svg>`
  );
}

/**
 * The 笔顺 filmstrip: one small frame per stroke, each adding a stroke to the last, with
 * the newest stroke dark and the earlier ones grey. Reading left to right gives both the
 * order and the direction of every stroke.
 */
export function strokeFilmstrip(glyph: Glyph, options: FilmstripOptions): string {
  const newFill = options.newStrokeFill ?? '#111';
  const priorFill = options.priorStrokeFill ?? '#c4c4c4';
  const total =
    options.maxFrames === undefined
      ? glyph.strokes.length
      : Math.min(glyph.strokes.length, options.maxFrames);

  const frames: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const prior = i === 0 ? '' : glyphPaths(glyph, { fill: priorFill, upTo: i });
    const newest = `<path d="${glyph.strokes[i]!}" fill="${newFill}"/>`;
    frames.push(
      `<svg class="frame" width="${options.sizeMm}mm" height="${options.sizeMm}mm" viewBox="${GLYPH_VIEWBOX}">` +
        `<g transform="${GLYPH_TRANSFORM}">${prior}${newest}</g></svg>`,
    );
  }
  return frames.join('');
}
