import { describe, it, expect } from 'vitest';
import { decodePng } from 'image-js';
import { referencePng, referenceStrokeCount } from './reference.js';

describe('reference character', () => {
  it('counts the reference strokes', () => {
    expect(referenceStrokeCount('待')).toBe(9);
  });

  it('renders the character as a square PNG, black on white', () => {
    const png = decodePng(referencePng('待')!);
    expect(png.width).toBe(183);
    expect(png.height).toBe(183);
    // First channel of every pixel: alpha (when present) is 255 everywhere and proves nothing.
    const data = png.getRawImage().data;
    const firstChannel = new Set<number>();
    for (let i = 0; i < data.length; i += png.channels) firstChannel.add(data[i]!);
    expect(firstChannel.has(0)).toBe(true);
    expect(firstChannel.has(255)).toBe(true);
  });

  // An upside-down or mirrored render is still black on white; only where the ink lands
  // shows the orientation. A glyph filling the box (道) looks the same flipped, so these
  // are radicals that occupy one side only: 冖 sits in the top 40%, 讠 in the left half.
  const inkIn = (char: string, region: { x0: number; x1: number; y0: number; y1: number }) => {
    const png = decodePng(referencePng(char)!);
    const data = png.getRawImage().data;
    const px = (f: number, n: number) => Math.round(f * n);
    for (let y = px(region.y0, png.height); y < px(region.y1, png.height); y += 1) {
      for (let x = px(region.x0, png.width); x < px(region.x1, png.width); x += 1) {
        if (data[(y * png.width + x) * png.channels]! < 128) return true;
      }
    }
    return false;
  };

  it('renders upright: 冖 has ink in the top quarter, none in the bottom half or margin', () => {
    expect(inkIn('冖', { x0: 0, x1: 1, y0: 0.1, y1: 0.25 })).toBe(true);
    expect(inkIn('冖', { x0: 0, x1: 1, y0: 0.5, y1: 1 })).toBe(false);
  });

  it('renders unmirrored: 讠 has ink in the left half, none in the right half', () => {
    expect(inkIn('讠', { x0: 0, x1: 0.5, y0: 0, y1: 1 })).toBe(true);
    expect(inkIn('讠', { x0: 0.5, x1: 1, y0: 0, y1: 1 })).toBe(false);
  });

  it('leaves the 10% margin empty on a glyph that fills the box', () => {
    for (const region of [
      { x0: 0, x1: 1, y0: 0, y1: 0.1 }, { x0: 0, x1: 1, y0: 0.9, y1: 1 },
      { x0: 0, x1: 0.1, y0: 0, y1: 1 }, { x0: 0.9, x1: 1, y0: 0, y1: 1 },
    ]) expect(inkIn('道', region)).toBe(false);
    expect(inkIn('道', { x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.25 })).toBe(true);
  });

  it('has nothing for a character without reference data', () => {
    for (const char of ['A', '㐀', '待待']) {
      expect(referenceStrokeCount(char)).toBeNull();
      expect(referencePng(char)).toBeNull();
    }
  });
});
