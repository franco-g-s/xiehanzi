/**
 * RATTA_RLE encoder.
 *
 * The inverse of the decoder in supernote-typescript / supernote-tool. The stream is pairs
 * of (colour byte, length byte):
 *
 *   length 0xFF          a run of exactly 0x4000 (16384) pixels
 *   length with bit 7set a "holder": combines with the FOLLOWING pair of the same colour,
 *                        giving 1 + next + (((len & 0x7f) + 1) << 7); if the following
 *                        pair is a different colour, the holder alone is
 *                        ((len & 0x7f) + 1) << 7 and that pair is decoded independently
 *   otherwise            a run of length + 1, so 1..128
 *
 * Cross-check that this reading is right: a blank Manta page is 1920x2560 = 4,915,200
 * pixels, and the device's own blank template is 600 bytes — exactly 300 pairs of
 * [0x62, 0xFF], and 4,915,200 / 16,384 = 300.
 */

/** Encoded palette values, from the decoder's table. */
export const RLE = {
  black: 0x61,
  background: 0x62,
  darkGray: 0x63,
  gray: 0x64,
  white: 0x65,
} as const;

const SPECIAL_MARKER = 0xff;
const SPECIAL_LENGTH = 0x4000;
/** A plain pair encodes at most this many pixels. */
const MAX_PLAIN = 128;

/** Emits the pairs for one run of a single colour. */
export function encodeRun(color: number, length: number, out: number[]): void {
  let remaining = length;

  // Whole 16384-pixel blocks get the special marker — the most compact form available.
  while (remaining >= SPECIAL_LENGTH) {
    out.push(color, SPECIAL_MARKER);
    remaining -= SPECIAL_LENGTH;
  }
  if (remaining === 0) return;

  if (remaining <= MAX_PLAIN) {
    out.push(color, remaining - 1);
    return;
  }

  // Holder form: 1 + m + ((k + 1) << 7) === remaining.
  const blocks = Math.floor((remaining - 1) / MAX_PLAIN);
  const rest = remaining - 1 - blocks * MAX_PLAIN;
  out.push(color, 0x80 | (blocks - 1), color, rest);
}

/**
 * Run-length encodes one byte per pixel, where each byte is already a palette code.
 */
export function encodeRle(colorCodes: Uint8Array): Buffer {
  const out: number[] = [];
  if (colorCodes.length === 0) return Buffer.alloc(0);

  let runColor = colorCodes[0]!;
  let runLength = 0;

  for (const code of colorCodes) {
    if (code === runColor) {
      runLength += 1;
      continue;
    }
    encodeRun(runColor, runLength, out);
    runColor = code;
    runLength = 1;
  }
  encodeRun(runColor, runLength, out);

  return Buffer.from(out);
}

/** A page of nothing but background — what an empty writing layer contains. */
export function blankLayer(width: number, height: number): Buffer {
  const out: number[] = [];
  encodeRun(RLE.background, width * height, out);
  return Buffer.from(out);
}

/**
 * Maps 8-bit greyscale to the palette. The sheet is black glyphs and grey rules on white,
 * so four levels are plenty and keep the encoding short.
 */
export function greyToPalette(grey: number): number {
  if (grey < 0x40) return RLE.black;
  if (grey < 0x90) return RLE.darkGray;
  // The 米字格 guides are #d5d5d5 (213). A background threshold below that erases them
  // from the sheet entirely — the cells come out as bare boxes with no cross or diagonals.
  if (grey < 0xe8) return RLE.gray;
  return RLE.background;
}

/**
 * The inverse of `encodeRle`: one palette code per pixel, row-major.
 *
 * Bounded by the pixel count rather than by the input length. A device-written file
 * routinely carries a final run that overshoots the page — reading past the end of `out`
 * would be a buffer overrun rather than a visible glitch, so the loop stops at `total`
 * regardless of what the trailing bytes claim.
 *
 * The reverse case matters just as much: a stream that UNDERSHOOTS the page leaves a tail
 * this loop never writes to. `Uint8Array` zero-initialises, and 0 is not `RLE.background`
 * (0x62) — so an uncovered tail must be pre-filled with background explicitly, or every
 * pixel the stream never reached decodes as ink. `grade.ts`'s ink ladder trusts this: a
 * page that decoded to a spurious near-100% ink fraction outside the writing would grade
 * every recall row on it as a pass, silently and permanently.
 */
export function decodeRle(data: Buffer, width: number, height: number): Uint8Array {
  const total = width * height;
  const out = new Uint8Array(total).fill(RLE.background);
  let at = 0;

  for (let i = 0; i + 1 < data.length && at < total; i += 2) {
    const color = data[i]!;
    const lengthByte = data[i + 1]!;

    let run: number;
    if (lengthByte === SPECIAL_MARKER) {
      run = SPECIAL_LENGTH;
    } else if ((lengthByte & 0x80) !== 0) {
      // Holder form: the low 7 bits are (blocks - 1); the following pair of the same
      // colour carries the remainder, one less than its actual contribution.
      //
      // ONLY of the same colour. The device emits holders followed by a pair of another
      // colour — a run ending exactly on a 128-px boundary, then a short mark — and there
      // the holder stands alone at blocks * 128 and the next pair decodes on its own,
      // exactly as supernote-typescript's RattaRLEDecoder does. Consuming it anyway
      // swallowed the mark and, when that pair was itself a holder or 0xFF, mis-sized the
      // run and shifted the rest of the page sideways (the displaced pages of
      // 2026-09-11..21). Our own encoder never writes this form, so generated sheets
      // decode identically either way.
      const blocks = (lengthByte & 0x7f) + 1;
      const rest = data[i + 3];
      if (rest === undefined || data[i + 2] !== color) {
        run = blocks * MAX_PLAIN;
      } else {
        run = blocks * MAX_PLAIN + (rest + 1);
        i += 2;
      }
    } else {
      run = lengthByte + 1;
    }

    out.fill(color, at, Math.min(at + run, total));
    at += run;
  }

  return out;
}
