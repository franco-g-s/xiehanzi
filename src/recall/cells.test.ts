import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodePng } from 'image-js';
import { parseTotalPath } from '../deliver/note/strokes.js';
import { RLE } from '../deliver/note/rle.js';
import { cellRect } from './grade.js';
import { strokesInCell, cellPng } from './cells.js';
import type { RecallGeometry } from '../state/sheets.js';

const PAGE_W_MM = 162.6, PAGE_H_MM = 216.7;

/** The geometry the 2026-09-29 sheet was printed with, copied from state/sheets.json. */
const sept29: RecallGeometry = {
  cellMm: 12.511111111111113, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.972727272727273,
  cellsPerRow: 6, rowsPerPage: 11, firstCellGapMm: 2.5,
};

const page = parseTotalPath(gunzipSync(readFileSync(
  new URL('../deliver/note/fixtures/2026-09-29-p2-totalpath.bin.gz', import.meta.url),
))).strokes;

describe('strokesInCell', () => {
  // Rows of that page and what was written in each answer cell, counted by hand from the
  // ink: 病 (partial) 5, 百 6, 真 10, 迟 8, 程 12, 纟 3, 还 7, 借 9.
  it.each([[2, 5], [3, 6], [4, 10], [5, 8], [6, 12], [7, 3], [9, 7], [10, 9]])(
    'row %i gets exactly its own %i strokes',
    (row, count) => {
      expect(strokesInCell(page, sept29, row, PAGE_W_MM, PAGE_H_MM)).toHaveLength(count);
    },
  );

  it('returns coordinates relative to the cell, inside it', () => {
    for (const stroke of strokesInCell(page, sept29, 9, PAGE_W_MM, PAGE_H_MM)) {
      for (const p of stroke) {
        expect(p.x).toBeGreaterThan(-3);
        expect(p.x).toBeLessThan(sept29.cellMm + 3);
        expect(p.y).toBeGreaterThan(-3);
        expect(p.y).toBeLessThan(sept29.cellMm + 3);
      }
    }
  });

  it('never hands a later cell\'s strokes to cell 0', () => {
    // Row 9's corrections were written in cells 2+; none of them may leak in.
    const all = strokesInCell(page, sept29, 9, PAGE_W_MM, PAGE_H_MM);
    expect(all.every((s) => s.every((p) => p.x < sept29.cellMm + 3))).toBe(true);
  });
});

describe('cellPng', () => {
  it('crops the cell with a margin, ink black on white', () => {
    const pixels = new Uint8Array(1920 * 2560).fill(RLE.background);
    const rect = cellRect(sept29, 0, 0);
    const cx = Math.round(((rect.xMm + rect.widthMm / 2) / PAGE_W_MM) * 1920);
    const cy = Math.round(((rect.yMm + rect.heightMm / 2) / PAGE_H_MM) * 2560);
    pixels[cy * 1920 + cx] = RLE.black;

    const png = decodePng(cellPng(pixels, rect, PAGE_W_MM, PAGE_H_MM));
    const expectedW = Math.round(((rect.widthMm + 3) / PAGE_W_MM) * 1920);
    expect(Math.abs(png.width - expectedW)).toBeLessThanOrEqual(1);
    const values = png.getRawImage().data;
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(255);
  });
});
