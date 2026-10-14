import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodeRle, encodeRle, blankLayer, greyToPalette, RLE } from './rle.js';
// Not re-exported from the package index; the decoder lives in its own module.
// eslint-disable-next-line import/no-internal-modules
import { RattaRLEDecoder } from 'supernote-typescript/lib/conversion.js';

/**
 * Decodes with the library's own decoder into one palette code per pixel.
 *
 * Returns a typed array: a full Manta page is 4.9M pixels, and comparing plain JS arrays
 * of that size takes minutes.
 */
function roundTrip(encoded: Buffer, width: number, height: number): Uint8Array {
  const rgba = new RattaRLEDecoder().decode(encoded, width, height);
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) {
    // background is TRANSPARENT, not white — alpha has to be checked first, or every
    // background pixel reads as black.
    if (rgba[i + 3] === 0) out[p] = RLE.background;
    else if (rgba[i] === 0) out[p] = RLE.black;
    else if (rgba[i] === 128) out[p] = RLE.darkGray;
    else if (rgba[i] === 255) out[p] = RLE.white;
    else out[p] = RLE.gray;
  }
  return out;
}

/** Compares without materialising huge arrays, and names the first differing pixel. */
function expectSamePixels(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  const at = actual.findIndex((v, i) => v !== expected[i]);
  expect(at === -1 ? 'identical' : `differs at pixel ${at}`).toBe('identical');
}

const codes = (spec: Array<[number, number]>): Uint8Array => {
  const out: number[] = [];
  for (const [color, n] of spec) for (let i = 0; i < n; i += 1) out.push(color);
  return Uint8Array.from(out);
};

describe('encodeRle — the device decoder must accept what we produce', () => {
  it('round-trips a single short run', () => {
    const px = codes([[RLE.black, 8]]);
    expectSamePixels(roundTrip(encodeRle(px), 8, 1), px);
  });

  it('round-trips a run of exactly 128, the largest plain pair', () => {
    const px = codes([[RLE.black, 128]]);
    expectSamePixels(roundTrip(encodeRle(px), 128, 1), px);
  });

  // 129 is the first length that needs the holder form.
  it('round-trips a run of 129', () => {
    const px = codes([[RLE.black, 129]]);
    expectSamePixels(roundTrip(encodeRle(px), 129, 1), px);
  });

  it('round-trips lengths either side of every boundary', () => {
    for (const n of [1, 2, 127, 128, 129, 255, 256, 16383, 16384, 16385, 20000]) {
      const px = codes([[RLE.black, n]]);
      expectSamePixels(roundTrip(encodeRle(px), n, 1), px);
    }
  });

  it('round-trips alternating colours', () => {
    const px = codes([[RLE.black, 3], [RLE.background, 5], [RLE.black, 200], [RLE.background, 1]]);
    expectSamePixels(roundTrip(encodeRle(px), px.length, 1), px);
  });

  it('round-trips a realistic full Manta page', () => {
    const width = 1920;
    const height = 2560;
    const px = new Uint8Array(width * height).fill(RLE.background);
    // A few horizontal rules and a block, like a practice grid.
    for (let y = 100; y < 105; y += 1) px.fill(RLE.black, y * width, y * width + width);
    for (let y = 500; y < 900; y += 1) px.fill(RLE.black, y * width + 40, y * width + 60);

    expectSamePixels(roundTrip(encodeRle(px), width, height), px);
  });
});

describe('blankLayer', () => {
  it('matches the device\'s own blank page byte for byte', () => {
    const blank = blankLayer(1920, 2560);
    // 1920*2560 / 16384 = 300 pairs of [background, 0xFF]
    expect(blank).toHaveLength(600);
    expect(blank.subarray(0, 4)).toEqual(Buffer.from([0x62, 0xff, 0x62, 0xff]));
  });

  it('decodes back to an entirely blank page', () => {
    const px = roundTrip(blankLayer(64, 64), 64, 64);
    expect(px.every((v) => v === RLE.background)).toBe(true);
  });
});

describe('greyToPalette', () => {
  it('maps ink to black and paper to background', () => {
    expect(greyToPalette(0)).toBe(RLE.black);
    expect(greyToPalette(255)).toBe(RLE.background);
  });

  it('gives the grid rules a mid tone rather than forcing them black', () => {
    expect(greyToPalette(0xb0)).toBe(RLE.gray);
    expect(greyToPalette(0x70)).toBe(RLE.darkGray);
  });

  // The 米字格 guides are #d5d5d5. Rounding them to paper deletes them from the sheet.
  it('keeps the faint 米字格 guides visible', () => {
    expect(greyToPalette(0xd5)).toBe(RLE.gray);
  });
});

describe('the palette itself', () => {
  it('treats background as transparent, which is what paper means here', () => {
    const rgba = new RattaRLEDecoder().decode(Buffer.from([RLE.background, 0]), 1, 1);
    expect(Array.from(rgba)).toEqual([0, 0, 0, 0]);
  });

  it('round-trips every grey level we emit', () => {
    const px = Uint8Array.from([RLE.black, RLE.darkGray, RLE.gray, RLE.background]);
    const back = roundTrip(encodeRle(px), 4, 1);
    expect(Array.from(back)).toEqual(Array.from(px));
  });
});

describe('decodeRle', () => {
  it('round-trips a solid field', () => {
    const pixels = new Uint8Array(16 * 4).fill(RLE.black);
    expect(decodeRle(encodeRle(pixels), 16, 4)).toEqual(pixels);
  });

  it('round-trips alternating runs', () => {
    const pixels = new Uint8Array(64);
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = i % 2 === 0 ? RLE.black : RLE.background;
    }
    expect(decodeRle(encodeRle(pixels), 8, 8)).toEqual(pixels);
  });

  it('decodes a blank layer as pure background', () => {
    const decoded = decodeRle(blankLayer(1920, 2560), 1920, 2560);
    expect(decoded.length).toBe(1920 * 2560);
    expect(decoded.every((c) => c === RLE.background)).toBe(true);
  });

  // The holder form only kicks in for 129..16383 pixels of one colour — shorter runs are
  // plain pairs, longer ones are whole 0xFF blocks plus a holder remainder. This exercises
  // the holder path in isolation, distinct from the multi-block test below.
  it('round-trips a run that needs the holder form (129..16383 px)', () => {
    const pixels = new Uint8Array(5000).fill(RLE.darkGray);
    expect(decodeRle(encodeRle(pixels), 5000, 1)).toEqual(pixels);
  });

  it('round-trips runs longer than a single length byte', () => {
    // 0xFF encodes 16384 px, so a field this size exercises the multi-run path.
    const pixels = new Uint8Array(40000).fill(RLE.gray);
    expect(decodeRle(encodeRle(pixels), 200, 200)).toEqual(pixels);
  });

  it('stops at the pixel count rather than trusting the data length', () => {
    // A trailing run that overshoots must not write past the buffer.
    const data = Buffer.from([RLE.black, 0xff, RLE.black, 0xff]);
    expect(decodeRle(data, 4, 4).length).toBe(16);
  });

  // CRITICAL: a `Uint8Array` initialises to all zeroes, which is NOT `RLE.background`
  // (0x62) — so before this fix, any pixel the RLE stream never reached decoded as ink.
  // A device-written MAINLAYER that ends short of the full page (rather than overshooting,
  // which the test above covers) would then read as nearly 100% inked everywhere the
  // stream didn't reach, and `inkFraction` would record every cell in that region as a
  // pass — silently, and on a path (real device notes) this project had not yet exercised.
  it('reads the uncovered tail as background, not as ink', () => {
    // A stream that covers only the first 4 of 16 pixels with black.
    const data = Buffer.from([RLE.black, 3]);
    const decoded = decodeRle(data, 4, 4);
    expect(decoded.length).toBe(16);
    expect(Array.from(decoded.subarray(0, 4))).toEqual([RLE.black, RLE.black, RLE.black, RLE.black]);
    expect(Array.from(decoded.subarray(4))).toEqual(new Array(12).fill(RLE.background));
  });

  it('agrees with supernote-typescript on a non-trivial field', () => {
    // Independent oracle: supernote-typescript's decoder is a wholly separate
    // implementation, so agreement here is evidence about decodeRle itself, not just about
    // encodeRle/decodeRle being mutually consistent.
    const pixels = new Uint8Array(1920 * 8);
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = [RLE.background, RLE.black, RLE.gray, RLE.darkGray][i % 4]!;
    }
    const encoded = encodeRle(pixels);
    expectSamePixels(decodeRle(encoded, 1920, 8), roundTrip(encoded, 1920, 8));
  });
});

// A holder's following pair is a continuation ONLY when it is the same colour. The device
// writes holders whose next pair is a different colour — a long run of paper ending
// exactly on a 128-px block boundary, followed by a short black mark — and reading that
// pair as the holder's remainder both swallows the mark (colour loss) and, when the
// swallowed pair is itself a holder or 0xFF, mis-sizes the run so everything below it on
// the page slides sideways (length drift). That was the "duplicated and clipped" page.
// (Found 2026-09-11 on a device-written page that came back duplicated and clipped.)
describe('decodeRle — a holder followed by a pair of a DIFFERENT colour', () => {
  it('ends the holder and decodes the next plain pair on its own (colour loss)', () => {
    // background holder of 4 blocks = 512 px, then 2 px of black.
    const data = Buffer.from([RLE.background, 0x83, RLE.black, 0x01]);
    const decoded = decodeRle(data, 514, 1);
    expect(decoded.subarray(0, 512).every((c) => c === RLE.background)).toBe(true);
    expect(Array.from(decoded.subarray(512))).toEqual([RLE.black, RLE.black]);
    expectSamePixels(decoded, roundTrip(data, 514, 1));
  });

  it('does not consume a following holder of another colour (length drift)', () => {
    // 0x62 0xc8 then 0x64 0x8b 0x64 0x55: the real adjacency from the 2026-10-02 p5 fixture
    // below (row 2005). The reference reads 73 blocks of background, then a gray holder of
    // 12 blocks + 86.
    const data = Buffer.from([RLE.background, 0xc8, RLE.gray, 0x8b, RLE.gray, 0x55]);
    const width = 73 * 128 + 12 * 128 + 86;
    const decoded = decodeRle(data, width, 1);
    expect(decoded.subarray(0, 73 * 128).every((c) => c === RLE.background)).toBe(true);
    expect(decoded.subarray(73 * 128).every((c) => c === RLE.gray)).toBe(true);
    expectSamePixels(decoded, roundTrip(data, width, 1));
  });

  it('does not consume a following 0xFF block of another colour', () => {
    const data = Buffer.from([RLE.background, 0x80, RLE.black, 0xff]);
    const width = 128 + 16384;
    const decoded = decodeRle(data, width, 1);
    expect(decoded.subarray(0, 128).every((c) => c === RLE.background)).toBe(true);
    expect(decoded.subarray(128).every((c) => c === RLE.black)).toBe(true);
    expectSamePixels(decoded, roundTrip(data, width, 1));
  });

  it('still joins a holder to a same-colour remainder', () => {
    const data = Buffer.from([RLE.black, 0x80, RLE.black, 0x04]);
    expect(decodeRle(data, 133, 1).every((c) => c === RLE.black)).toBe(true);
  });

  // A device stream can end on a holder, with no pair after it at all. The holder then
  // stands alone at blocks * 128. Black rather than background on purpose: the output is
  // pre-filled with background, so a background holder that wrote nothing would still pass.
  it('decodes a holder that ends the stream on its own', () => {
    const data = Buffer.from([RLE.gray, 0x00, RLE.black, 0x81]);
    const width = 1 + 2 * 128;
    const decoded = decodeRle(data, width, 1);
    expect(decoded[0]).toBe(RLE.gray);
    expect(decoded.subarray(1).every((c) => c === RLE.black)).toBe(true);
    expectSamePixels(decoded, roundTrip(data, width, 1));
  });

  it('ignores a dangling odd byte after a final holder, even of the same colour', () => {
    // The holder has no remainder byte to join, so it stands alone at 2 * 128.
    const data = Buffer.from([RLE.black, 0x81, RLE.black]);
    const decoded = decodeRle(data, 256, 1);
    expect(decoded.every((c) => c === RLE.black)).toBe(true);
    expectSamePixels(decoded, roundTrip(data, 256, 1));
  });
});

/**
 * Real device-written LAYER1 streams, pulled back off the Supernote: xiehanzi sheets the
 * device re-encoded after handwriting went onto the page. Its encoder, unlike ours, writes
 * holders followed by a pair of another colour: all three pages carry the colour-loss case
 * (a holder then a plain pair), and 2026-10-02 p5 also carries the length-drift case (a
 * holder then a holder). Each hash is the decode of the page as BUILT and pushed, checked
 * against the generated note's own LAYER1, so a pass means the pulled page reads back
 * pixel for pixel as the sheet that was shipped, not merely as some other decoder's
 * opinion of it.
 */
const DEVICE_PAGES: Array<[string, string]> = [
  ['2026-10-02-p5', '138556e07492e36192273e7f345fd4aee9406da3de51259221a0e401a65aa740'],
  ['2026-10-08-p5', '060e22292f9f6783b4954bdaec5fe75178151ed60c26de42a08f121a9afb08f0'],
  ['2026-10-13-p3', '997d51e3aea188ae7c0afe00becf6d08c818380b6176fe58a38275792c28693d'],
];

describe('decodeRle — pages the device re-encoded', () => {
  for (const [name, builtSha] of DEVICE_PAGES) {
    it(`reads ${name} back exactly as it was built`, () => {
      const url = new URL(`./fixtures/${name}-layer1.rle.gz`, import.meta.url);
      const stream = gunzipSync(readFileSync(url));
      const decoded = decodeRle(stream, 1920, 2560);
      expectSamePixels(decoded, roundTrip(stream, 1920, 2560));
      expect(createHash('sha256').update(decoded).digest('hex')).toBe(builtSha);
    });
  }
});
