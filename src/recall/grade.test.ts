import { describe, it, expect } from 'vitest';
import { cellRect, locateCell, inkFraction, transcriptionForRow, INK_THRESHOLD } from './grade.js';
import { encodeRle, decodeRle, RLE } from '../deliver/note/rle.js';
import type { RecallGeometry } from '../state/sheets.js';

const geometry: RecallGeometry = {
  cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11,
};
const PAGE_W_MM = 162.6, PAGE_H_MM = 216.7, PX_W = 1920, PX_H = 2560;

/** A page whose only ink is a filled block covering one cell. */
function pageWithInkAt(row: number, cell: number): Buffer {
  return pageWithInkAtCells([[row, cell]]);
}

/** A page whose only ink is filled blocks covering the given (row, cell) pairs. */
function pageWithInkAtCells(cells: readonly [row: number, cell: number][]): Buffer {
  const pixels = new Uint8Array(PX_W * PX_H).fill(RLE.background);
  for (const [row, cell] of cells) {
    const r = cellRect(geometry, row, cell);
    const x0 = Math.round((r.xMm / PAGE_W_MM) * PX_W), x1 = Math.round(((r.xMm + r.widthMm) / PAGE_W_MM) * PX_W);
    const y0 = Math.round((r.yMm / PAGE_H_MM) * PX_H), y1 = Math.round(((r.yMm + r.heightMm) / PAGE_H_MM) * PX_H);
    for (let y = y0; y < y1; y += 1) pixels.fill(RLE.black, y * PX_W + x0, y * PX_W + x1);
  }
  return encodeRle(pixels);
}

/**
 * The same layout printed with the first cell set apart from the rest. `geometry` above is
 * deliberately left without the field, because that is exactly the shape every manifest
 * written before the gap existed still has on disk.
 */
const gapped: RecallGeometry = { ...geometry, firstCellGapMm: 2.5 };

describe('cellRect / locateCell — the graded first cell is set apart', () => {
  it('leaves cell 0 where it was', () => {
    expect(cellRect(gapped, 0, 0).xMm).toBeCloseTo(gapped.originXMm, 5);
  });

  it('shifts every later cell right by the gap', () => {
    for (let cell = 1; cell < gapped.cellsPerRow; cell += 1) {
      expect(cellRect(gapped, 0, cell).xMm)
        .toBeCloseTo(gapped.originXMm + cell * gapped.cellMm + gapped.firstCellGapMm!, 5);
    }
  });

  it('round-trips every cell centre back to its own cell', () => {
    for (let cell = 0; cell < gapped.cellsPerRow; cell += 1) {
      const r = cellRect(gapped, 2, cell);
      expect(locateCell(gapped, r.xMm + r.widthMm / 2, r.yMm + r.heightMm / 2))
        .toEqual({ row: 2, cell });
    }
  });

  it('claims nothing for the gap itself, which is part of no cell', () => {
    const x = gapped.originXMm + gapped.cellMm + gapped.firstCellGapMm! / 2;
    expect(locateCell(gapped, x, gapped.originYMm + 5)).toBeNull();
  });

  // state/sheets.json is the real, irreplaceable record of what was printed. A sheet
  // written on yesterday must grade against yesterday's layout, and yesterday's layout has
  // no such field — a missing gap is zero, never today's default.
  it('treats a manifest written before the gap existed as having none', () => {
    for (let cell = 0; cell < geometry.cellsPerRow; cell += 1) {
      expect(cellRect(geometry, 0, cell).xMm)
        .toBeCloseTo(geometry.originXMm + cell * geometry.cellMm, 5);
    }
  });

  it('locates a cell in a gapless manifest exactly as it always did', () => {
    const r = cellRect(geometry, 3, 4);
    expect(locateCell(geometry, r.xMm + r.widthMm / 2, r.yMm + r.heightMm / 2))
      .toEqual({ row: 3, cell: 4 });
  });
});

describe('cellRect / locateCell', () => {
  it('places cell 0 of row 0 at the origin', () => {
    expect(cellRect(geometry, 0, 0)).toEqual({
      xMm: 14, yMm: 15.4, widthMm: 12.5, heightMm: 12.5,
    });
  });

  it('round-trips every cell centre back to its own cell', () => {
    for (let row = 0; row < geometry.rowsPerPage; row += 1) {
      for (let cell = 0; cell < geometry.cellsPerRow; cell += 1) {
        const r = cellRect(geometry, row, cell);
        expect(locateCell(geometry, r.xMm + r.widthMm / 2, r.yMm + r.heightMm / 2))
          .toEqual({ row, cell });
      }
    }
  });

  it('rejects a point in the cue band above a row', () => {
    // The gap between one row's cells and the next row's cue belongs to no cell.
    const r = cellRect(geometry, 1, 0);
    expect(locateCell(geometry, r.xMm + 1, r.yMm - 2)).toBeNull();
  });

  it('rejects a point left of the first cell', () => {
    expect(locateCell(geometry, geometry.originXMm - 5, geometry.originYMm + 5)).toBeNull();
  });

  it('rejects a point right of the last cell', () => {
    const beyond = geometry.originXMm + geometry.cellsPerRow * geometry.cellMm + 5;
    expect(locateCell(geometry, beyond, geometry.originYMm + 5)).toBeNull();
  });

  it('rejects a point below the last row', () => {
    const below = geometry.originYMm + geometry.rowsPerPage * geometry.rowPitchMm + 5;
    expect(locateCell(geometry, geometry.originXMm + 5, below)).toBeNull();
  });
});

describe('inkFraction', () => {
  it('is zero on a blank page', () => {
    const blank = new Uint8Array(PX_W * PX_H).fill(RLE.background);
    expect(inkFraction(blank, PAGE_W_MM, PAGE_H_MM, cellRect(geometry, 0, 0))).toBe(0);
  });

  it('is near one for a fully inked cell', () => {
    const pixels = new Uint8Array(PX_W * PX_H).fill(RLE.black);
    expect(inkFraction(pixels, PAGE_W_MM, PAGE_H_MM, cellRect(geometry, 0, 0))).toBeGreaterThan(0.99);
  });

  it('sees ink only in the cell that has it', () => {
    const pixels = decodeRle(pageWithInkAt(2, 0), PX_W, PX_H);
    expect(inkFraction(pixels, PAGE_W_MM, PAGE_H_MM, cellRect(geometry, 2, 0))).toBeGreaterThan(INK_THRESHOLD);
    expect(inkFraction(pixels, PAGE_W_MM, PAGE_H_MM, cellRect(geometry, 2, 1))).toBeLessThan(INK_THRESHOLD);
    expect(inkFraction(pixels, PAGE_W_MM, PAGE_H_MM, cellRect(geometry, 0, 0))).toBeLessThan(INK_THRESHOLD);
  });
});

describe('transcriptionForRow', () => {
  const word = (label: string, row: number, cell: number) => {
    const r = cellRect(geometry, row, cell);
    return { label, x: r.xMm + 2, y: r.yMm + 2, width: r.widthMm - 4, height: r.heightMm - 4 };
  };

  // The rest of the row is written after checking the solutions page: reading a correction
  // there as the answer would pass a character that was failed.
  it('takes the word in the first cell, ignoring corrections further along the row', () => {
    const found = transcriptionForRow([word('成', 0, 2), word('市', 0, 0)], geometry, 0);
    expect(found?.label).toBe('市');
    expect(transcriptionForRow([word('市', 0, 2)], geometry, 0)).toBeNull();
  });

  it('ignores marks outside every cell', () => {
    const left = { label: '市', x: geometry.originXMm - 10, y: geometry.originYMm + 2, width: 6, height: 6 };
    // Below the cell band of row 0, on its cue line: that is cue text, not an answer.
    const cue = { label: '市', x: geometry.originXMm + 2, y: geometry.originYMm + geometry.cellMm + 1, width: 6, height: 2 };
    expect(transcriptionForRow([left, cue], geometry, 0)).toBeNull();
  });

  it('only answers for the row asked about', () => {
    const words = [word('市', 0, 0), word('城', 1, 0)];
    expect(transcriptionForRow(words, geometry, 1)?.label).toBe('城');
    expect(transcriptionForRow(words, geometry, 2)).toBeNull();
  });
});
