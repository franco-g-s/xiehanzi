/**
 * Pen strokes out of a page's TOTALPATH block — the vector record of every stroke, in the
 * order it was written. MAINLAYER is the same ink rasterised; strokes keep the trajectory,
 * which is what makes online handwriting recognition possible and far more accurate for
 * Chinese than reading a picture.
 *
 * The format is reverse-engineered, not documented. Verified on the Manta against the
 * rasterised layer: every one of 3,873 strokes on the graded cells of 2026-08-24..09-29
 * lands on visible ink, so erased strokes are not left behind in this block.
 *
 * Layout: a uint32 stroke count, then per stroke a uint32 byte length and a record whose
 * uint32 at index 53 is the point count, followed by that many (a, b) uint32 pairs. What
 * comes after the points (pressure and so on) is ignored. Anything that does not fit is
 * skipped and counted rather than thrown: a firmware change to this block must make a
 * night degraded, never make grading crash.
 *
 * Stroke order is simply the order of strokes here. It is documented as available and is
 * deliberately not used by grading.
 */

/** Page pixels, in the same 1920×2560 space as the decoded MAINLAYER bitmap. */
export type StrokePoint = { x: number; y: number };
export type Stroke = StrokePoint[];
export type ParsedStrokes = { strokes: Stroke[]; skipped: number };

/** Digitizer units per screen pixel. 2560 px of height span 21,600 units. */
const DIGITIZER_PER_PX = 8.4375;
/** The digitizer's b axis runs right to left across the page. */
const DIGITIZER_X_FLIP = 16200;
const POINT_COUNT_INDEX = 53;
const POINTS_OFFSET = (POINT_COUNT_INDEX + 1) * 4;

export function parseTotalPath(block: Buffer): ParsedStrokes {
  if (block.length < 4) return { strokes: [], skipped: 0 };

  const count = block.readUInt32LE(0);
  const strokes: Stroke[] = [];
  let skipped = 0;
  let offset = 4;

  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > block.length) {
      skipped += count - i;
      break;
    }
    const length = block.readUInt32LE(offset);
    const start = offset + 4;
    const end = start + length;
    if (end > block.length) {
      skipped += count - i;
      break;
    }
    offset = end;

    if (length < POINTS_OFFSET) {
      skipped += 1;
      continue;
    }
    const points = block.readUInt32LE(start + POINT_COUNT_INDEX * 4);
    if (points === 0 || POINTS_OFFSET + points * 8 > length) {
      skipped += 1;
      continue;
    }

    const stroke: Stroke = [];
    for (let p = 0; p < points; p += 1) {
      const at = start + POINTS_OFFSET + p * 8;
      const a = block.readUInt32LE(at);
      const b = block.readUInt32LE(at + 4);
      stroke.push({ x: (DIGITIZER_X_FLIP - b) / DIGITIZER_PER_PX, y: a / DIGITIZER_PER_PX });
    }
    strokes.push(stroke);
  }

  return { strokes, skipped };
}
