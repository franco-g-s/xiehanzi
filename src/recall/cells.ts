/**
 * One graded cell, in the two forms recognisers read: its strokes (for stroke-based
 * recognition) and a picture of it (for vision models).
 *
 * A stroke belongs to the cell its centroid falls in, using the same geometry grading has
 * always used. Centroid rather than "any point inside" so a long stroke that clips the
 * cell edge on its way to the next cell is not handed to the wrong attempt.
 */

import { Image, encodePng } from 'image-js';
import { RLE } from '../deliver/note/rle.js';
import { cellRect, locateCell, type CellRect } from './grade.js';
import type { Stroke } from '../deliver/note/strokes.js';
import type { RecallGeometry } from '../state/sheets.js';

const PX_W = 1920;
const PX_H = 2560;

/** Millimetres, relative to the cell's top-left corner. */
export type CellStroke = { x: number; y: number }[];

export type Cell = { strokes: CellStroke[]; png: Buffer; cellMm: number };

/** Strokes whose centroid lands in a row's graded first cell. */
export function strokesInCell(
  strokes: readonly Stroke[],
  geometry: RecallGeometry,
  row: number,
  pageWidthMm: number,
  pageHeightMm: number,
): CellStroke[] {
  const rect = cellRect(geometry, row, 0);
  const toMm = (p: { x: number; y: number }) => ({
    x: (p.x / PX_W) * pageWidthMm,
    y: (p.y / PX_H) * pageHeightMm,
  });

  const out: CellStroke[] = [];
  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    const mm = stroke.map(toMm);
    const cx = mm.reduce((s, p) => s + p.x, 0) / mm.length;
    const cy = mm.reduce((s, p) => s + p.y, 0) / mm.length;
    const at = locateCell(geometry, cx, cy);
    if (at === null || at.row !== row || at.cell !== 0) continue;
    out.push(mm.map((p) => ({ x: p.x - rect.xMm, y: p.y - rect.yMm })));
  }
  return out;
}

/**
 * The cell as a greyscale PNG, ink black on white, with a margin so a character written
 * slightly over the cell edge is not cut off. Only MAINLAYER pixels are used, so the
 * printed grid never appears: the picture is Franco's handwriting alone.
 */
export function cellPng(
  pixels: Uint8Array,
  rect: CellRect,
  pageWidthMm: number,
  pageHeightMm: number,
  marginMm = 1.5,
): Buffer {
  const x0 = Math.max(0, Math.round(((rect.xMm - marginMm) / pageWidthMm) * PX_W));
  const x1 = Math.min(PX_W, Math.round(((rect.xMm + rect.widthMm + marginMm) / pageWidthMm) * PX_W));
  const y0 = Math.max(0, Math.round(((rect.yMm - marginMm) / pageHeightMm) * PX_H));
  const y1 = Math.min(PX_H, Math.round(((rect.yMm + rect.heightMm + marginMm) / pageHeightMm) * PX_H));

  const width = x1 - x0;
  const height = y1 - y0;
  const image = new Image(width, height, { colorModel: 'GREY' });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inked = pixels[(y0 + y) * PX_W + x0 + x] !== RLE.background;
      image.setValueByIndex(y * width + x, 0, inked ? 0 : 255);
    }
  }
  return Buffer.from(encodePng(image));
}
