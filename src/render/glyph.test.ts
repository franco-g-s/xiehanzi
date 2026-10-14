import { describe, it, expect } from 'vitest';
import { loadGlyph, glyphPaths, strokeFilmstrip, GLYPH_TRANSFORM } from './glyph.js';

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('loadGlyph', () => {
  it('loads a character from the dataset', () => {
    const g = loadGlyph('木');
    expect(g).not.toBeNull();
    expect(g!.strokes).toHaveLength(4);
    expect(g!.char).toBe('木');
  });

  it('knows the stroke count of a complex character', () => {
    expect(loadGlyph('惯')!.strokes).toHaveLength(11);
  });

  // Coverage is ~9,500 characters, so a miss is a real case the sheet must handle.
  it('returns null for a character outside the dataset', () => {
    expect(loadGlyph('𰻞')).toBeNull();
    expect(loadGlyph('a')).toBeNull();
    expect(loadGlyph('')).toBeNull();
  });

  it('does not blow up on path-traversal-looking input', () => {
    expect(loadGlyph('../package')).toBeNull();
    expect(loadGlyph('木木')).toBeNull();
  });
});

describe('glyphPaths', () => {
  const g = loadGlyph('木')!;

  it('emits one path per stroke', () => {
    expect(count(glyphPaths(g, { fill: '#000' }), '<path')).toBe(4);
  });

  it('applies the requested colour', () => {
    expect(glyphPaths(g, { fill: '#888' })).toContain('fill="#888"');
  });

  it('applies opacity when fading', () => {
    expect(glyphPaths(g, { fill: '#000', opacity: 0.25 })).toContain('opacity="0.25"');
  });

  it('omits opacity when fully solid', () => {
    expect(glyphPaths(g, { fill: '#000' })).not.toContain('opacity');
  });

  it('can render only the first n strokes', () => {
    expect(count(glyphPaths(g, { fill: '#000', upTo: 2 }), '<path')).toBe(2);
  });

  // Data has y increasing upward; SVG has it increasing downward.
  it('exposes a transform that flips the y axis', () => {
    expect(GLYPH_TRANSFORM).toContain('scale(1, -1)');
  });
});

describe('strokeFilmstrip', () => {
  const g = loadGlyph('木')!;
  const strip = strokeFilmstrip(g, { sizeMm: 5 });

  it('shows one frame per stroke', () => {
    expect(count(strip, '<svg')).toBe(4);
  });

  it('builds up cumulatively — the last frame has every stroke', () => {
    const frames = strip.split('<svg').slice(1);
    expect(count(frames[0]!, '<path')).toBe(1);
    expect(count(frames[3]!, '<path')).toBe(4);
  });

  it('emphasises the newest stroke against the earlier ones', () => {
    const third = strip.split('<svg')[3]!;
    // Two greyed strokes plus one dark: more than one fill colour in the frame.
    const fills = new Set(third.match(/fill="[^"]+"/g) ?? []);
    expect(fills.size).toBeGreaterThan(1);
  });

  it('sizes each frame in millimetres so print scale is exact', () => {
    expect(strip).toContain('width="5mm"');
  });

  it('caps very long characters so the strip cannot overrun the row', () => {
    const dragon = loadGlyph('龘') ?? loadGlyph('籲') ?? loadGlyph('鑫');
    if (dragon === null) return;
    const capped = strokeFilmstrip(dragon, { sizeMm: 5, maxFrames: 6 });
    expect(count(capped, '<svg')).toBeLessThanOrEqual(6);
  });
});
