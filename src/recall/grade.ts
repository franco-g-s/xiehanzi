/**
 * Recall-page geometry and ink measurement: where each cell sits on the page, which cell a
 * point falls in, and how much of a cell is inked.
 *
 * Pure: bytes and geometry in, numbers out. No clock, no network, no filesystem. Verdicts
 * are not made here; they live in `assess.ts` (a page into reviews) and `verdict.ts` (the
 * policy that turns recogniser readings into a pass or a fail).
 *
 * Only the first cell of each row is ever graded. The rest are written after checking the
 * solutions page, so reading them would score a corrected failure as a pass.
 *
 * The writing layer is pure handwriting: the sheet itself lives in LAYER1, so anything in
 * MAINLAYER was put there by Franco. Ink detection needs no background subtraction.
 */

import { RLE } from '../deliver/note/rle.js';
import { splitWideBox, type RecognisedWord } from '../deliver/note/read.js';
import type { RecallGeometry } from '../state/sheets.js';

const PX_W = 1920;
const PX_H = 2560;

export type CellRect = { xMm: number; yMm: number; widthMm: number; heightMm: number };

/**
 * Cell 0 is the graded one and is printed set apart from the rest, so everything after it
 * starts a gap further right. A manifest predating the gap has no such field, and absent
 * must mean zero: those sheets were printed without one and must grade as they were
 * printed, not as today's page would be.
 */
const gapBefore = (geometry: RecallGeometry, cell: number): number =>
  cell === 0 ? 0 : geometry.firstCellGapMm ?? 0;

export function cellRect(geometry: RecallGeometry, row: number, cell: number): CellRect {
  return {
    xMm: geometry.originXMm + cell * geometry.cellMm + gapBefore(geometry, cell),
    yMm: geometry.originYMm + row * geometry.rowPitchMm,
    widthMm: geometry.cellMm,
    heightMm: geometry.cellMm,
  };
}

export function locateCell(
  geometry: RecallGeometry,
  xMm: number,
  yMm: number,
): { row: number; cell: number } | null {
  const dx = xMm - geometry.originXMm;
  if (dx < 0) return null;
  const gap = geometry.firstCellGapMm ?? 0;
  // The gap belongs to no cell. Handing it to cell 0 — the one cell whose ink is taken as
  // the single graded attempt — would let a stroke that overshot cell 2 record a pass.
  if (dx >= geometry.cellMm && dx < geometry.cellMm + gap) return null;
  const cell =
    dx < geometry.cellMm ? 0 : 1 + Math.floor((dx - geometry.cellMm - gap) / geometry.cellMm);
  if (cell >= geometry.cellsPerRow) return null;

  const dy = yMm - geometry.originYMm;
  if (dy < 0) return null;
  const row = Math.floor(dy / geometry.rowPitchMm);
  if (row >= geometry.rowsPerPage) return null;
  // Each row's pitch spans its cue line plus its cell band; only the cell band, at the
  // start of the pitch, counts. A point past cellMm into the pitch is cue text belonging
  // to the *next* row, and grading it would score a transcribed cue as an answer.
  if (dy - row * geometry.rowPitchMm > geometry.cellMm) return null;

  return { row, cell };
}

/** INK_THRESHOLD sits well clear of both a written character (5-20% of a cell) and a
 * stray dot (well under 0.1%), so it separates the two without needing to be exact. */
export const INK_THRESHOLD = 0.005;

export function inkFraction(
  pixels: Uint8Array,
  pageWidthMm: number,
  pageHeightMm: number,
  rect: CellRect,
): number {
  const x0 = Math.round((rect.xMm / pageWidthMm) * PX_W);
  const x1 = Math.round(((rect.xMm + rect.widthMm) / pageWidthMm) * PX_W);
  const y0 = Math.round((rect.yMm / pageHeightMm) * PX_H);
  const y1 = Math.round(((rect.yMm + rect.heightMm) / pageHeightMm) * PX_H);

  let inked = 0;
  let total = 0;
  for (let y = y0; y < y1; y += 1) {
    const rowStart = y * PX_W;
    for (let x = x0; x < x1; x += 1) {
      total += 1;
      if (pixels[rowStart + x] !== RLE.background) inked += 1;
    }
  }

  return total === 0 ? 0 : inked / total;
}

/** The transcription word, if any, whose box centre lands in a row's first cell. */
export function transcriptionForRow(
  words: readonly RecognisedWord[],
  geometry: RecallGeometry,
  row: number,
): RecognisedWord | null {
  for (const word of words) {
    for (const part of splitWideBox(word)) {
      const at = locateCell(geometry, part.x + part.width / 2, part.y + part.height / 2);
      if (at !== null && at.row === row && at.cell === 0) return part;
    }
  }
  return null;
}
