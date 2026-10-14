/**
 * The target character as the partner sees it beside the handwriting: printed in 楷书 from
 * hanzi-writer-data, the same outlines the practice sheets are drawn from.
 *
 * Shown a reference, the partner judges "is this the target, written correctly?" rather
 * than guessing blind what was written; see go.ts for why that is the better question.
 */

import { Canvas, Path2D } from 'skia-canvas';
import { loadGlyph } from '../../render/glyph.js';

/** hanzi-writer coordinates: a 1024 box, y up, baseline at 900. */
const BOX = 1024;
const BASELINE = 900;

/** Strokes in the reference, or null when hanzi-writer-data has no such character. */
export function referenceStrokeCount(char: string): number | null {
  return loadGlyph(char)?.strokes.length ?? null;
}

/**
 * Black on white with a 10% margin. The default 183 px matches a 12.5 mm cell crop
 * (with its 1.5 mm margins) at the page's resolution, so both images are the same size.
 */
export function referencePng(char: string, sizePx = 183): Buffer | null {
  const glyph = loadGlyph(char);
  if (glyph === null) return null;

  const canvas = new Canvas(sizePx, sizePx);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sizePx, sizePx);

  const pad = sizePx * 0.1;
  const s = (sizePx - 2 * pad) / BOX;
  ctx.translate(pad, pad + BASELINE * s);
  ctx.scale(s, -s);
  ctx.fillStyle = '#000';
  for (const d of glyph.strokes) ctx.fill(new Path2D(d));

  return canvas.toBufferSync('png');
}
