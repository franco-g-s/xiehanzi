import { describe, it, expect } from 'vitest';
import { readNote, splitWideBox } from './read.js';
import { writeNote } from './write.js';
import { blankLayer, encodeRle, RLE } from './rle.js';

const PAGE = { width: 1920, height: 2560 };

function inkedLayer(): Buffer {
  const pixels = new Uint8Array(PAGE.width * PAGE.height).fill(RLE.background);
  pixels.fill(RLE.black, 0, 5000);
  return encodeRle(pixels);
}

describe('readNote', () => {
  it('finds every page of a note we wrote', () => {
    const note = writeNote(
      [{ background: blankLayer(PAGE.width, PAGE.height) },
       { background: blankLayer(PAGE.width, PAGE.height) }],
      { seed: 'test' },
    );
    expect(readNote(note).pages).toHaveLength(2);
  });

  it('reports no recognition for a note that was never transcribed', () => {
    const note = writeNote([{ background: blankLayer(PAGE.width, PAGE.height) }], { seed: 'test' });
    expect(readNote(note).pages[0]!.recognition).toBeNull();
  });

  it('recovers the writing layer that was put in', () => {
    const writing = inkedLayer();
    const note = writeNote(
      [{ background: blankLayer(PAGE.width, PAGE.height), writing }],
      { seed: 'test' },
    );
    expect(readNote(note).pages[0]!.writing).toEqual(writing);
  });

  it('rejects bytes that are not a note', () => {
    expect(() => readNote(Buffer.from('definitely not a note'))).toThrow(/not a Supernote/i);
  });
});

describe('splitWideBox', () => {
  it('leaves a single-character box alone', () => {
    const word = { label: '我', x: 39.4, y: 25.6, width: 7.5, height: 9.7 };
    expect(splitWideBox(word)).toEqual([word]);
  });

  it('divides a two-character box evenly across x', () => {
    // Observed in real data: 你好 arrived as one 24mm-wide box.
    const parts = splitWideBox({ label: '你好', x: 10, y: 20, width: 24, height: 10 });
    expect(parts).toEqual([
      { label: '你', x: 10, y: 20, width: 12, height: 10 },
      { label: '好', x: 22, y: 20, width: 12, height: 10 },
    ]);
  });

  it('splits by code point, not by UTF-16 unit', () => {
    // An extension-plane character is two UTF-16 units; splitting on .length would
    // produce two half-characters of mojibake.
    const parts = splitWideBox({ label: '\u{20BB7}好', x: 0, y: 0, width: 20, height: 10 });
    expect(parts).toHaveLength(2);
    expect(parts[0]!.label).toBe('\u{20BB7}');
  });
});
