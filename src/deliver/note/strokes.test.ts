import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseTotalPath } from './strokes.js';

const realPage = gunzipSync(
  readFileSync(new URL('./fixtures/2026-09-29-p2-totalpath.bin.gz', import.meta.url)),
);

/** One stroke record: 53 header words, the point count, the points, then trailing data. */
function record(points: [a: number, b: number][], claimed = points.length): Buffer {
  const words = new Array<number>(53).fill(0);
  words.push(claimed);
  for (const [a, b] of points) words.push(a, b);
  words.push(0, 0, 0);
  const body = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => body.writeUInt32LE(w, i * 4));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([len, body]);
}

function block(records: Buffer[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32LE(records.length, 0);
  return Buffer.concat([count, ...records]);
}

describe('parseTotalPath', () => {
  it('reads every stroke on a real written page', () => {
    const { strokes, skipped } = parseTotalPath(realPage);
    expect(skipped).toBe(0);
    expect(strokes).toHaveLength(415);
  });

  it('puts every real point on the page', () => {
    for (const stroke of parseTotalPath(realPage).strokes) {
      expect(stroke.length).toBeGreaterThan(0);
      for (const p of stroke) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1920);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(2560);
      }
    }
  });

  it('maps digitizer units to page pixels, flipping x', () => {
    const { strokes } = parseTotalPath(block([record([[8438, 15356]])]));
    expect(strokes[0]![0]!.x).toBeCloseTo((16200 - 15356) / 8.4375, 5);
    expect(strokes[0]![0]!.y).toBeCloseTo(8438 / 8.4375, 5);
  });

  it('skips a stroke whose point count overruns its record, and keeps the rest', () => {
    const { strokes, skipped } = parseTotalPath(
      block([record([[100, 100]], 9999), record([[200, 200], [300, 300]])]),
    );
    expect(skipped).toBe(1);
    expect(strokes).toHaveLength(1);
    expect(strokes[0]).toHaveLength(2);
  });

  it('stops cleanly on a truncated block instead of throwing', () => {
    const full = block([record([[1, 1]]), record([[2, 2]])]);
    const { strokes, skipped } = parseTotalPath(full.subarray(0, full.length - 20));
    expect(strokes).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('returns nothing for an empty block', () => {
    expect(parseTotalPath(Buffer.alloc(0))).toEqual({ strokes: [], skipped: 0 });
  });
});
