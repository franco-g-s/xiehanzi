/**
 * The inverse of `write.ts`: a `.note` container back into pages.
 *
 * Only what grading needs is recovered — the handwriting layer and the device's
 * transcription. Everything else in the container is left unread, so a firmware change to
 * a field we ignore cannot break grading.
 *
 * `writing` comes back as the raw MAINLAYER RLE, undecoded. Decoding is 4.9 MB of pixels
 * per page; that cost belongs to whatever grading code actually needs the bitmap, not to
 * every caller that only wants the transcription.
 *
 * Pen strokes are recovered too, out of TOTALPATH — the vector trajectory behind the same
 * ink, for stroke-based recognition.
 */

import { SIGNATURE } from './write.js';
import { parseTotalPath, type Stroke } from './strokes.js';

export type RecognisedWord = {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ParsedPage = {
  recognition: RecognisedWord[] | null;
  writing: Buffer | null;
  /** Absent when the page has no TOTALPATH. Optional so hand-built test pages need not carry it. */
  strokes?: Stroke[];
};

export type ParsedNote = { pages: ParsedPage[] };

/** Every `<KEY:value>` in a metadata block. */
function parseTags(text: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const match of text.matchAll(/<([A-Z_0-9]+):([^>]*)>/g)) {
    tags.set(match[1]!, match[2]!);
  }
  return tags;
}

function blockAt(bytes: Buffer, address: number): Buffer {
  if (address <= 0 || address + 4 > bytes.length) {
    throw new Error(`Block address ${address} is outside the file.`);
  }
  const length = bytes.readUInt32LE(address);
  const start = address + 4;
  if (start + length > bytes.length) {
    throw new Error(`Block at ${address} claims ${length} bytes but the file ends sooner.`);
  }
  return bytes.subarray(start, start + length);
}

const textBlockAt = (bytes: Buffer, address: number): Map<string, string> =>
  parseTags(blockAt(bytes, address).toString('utf8'));

/**
 * The device stores recognition as base64-encoded JSON, with bounding boxes already in
 * millimetres — which is why grading never has to convert pixels.
 */
function parseRecognition(block: Buffer): RecognisedWord[] {
  const decoded = Buffer.from(block.toString('utf8'), 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as {
    elements?: { words?: { label?: string; 'bounding-box'?: Record<string, number> }[] }[];
  };

  const words: RecognisedWord[] = [];
  for (const element of parsed.elements ?? []) {
    for (const word of element.words ?? []) {
      const box = word['bounding-box'];
      if (word.label === undefined || box === undefined) continue;
      words.push({
        label: word.label,
        x: box.x ?? 0,
        y: box.y ?? 0,
        width: box.width ?? 0,
        height: box.height ?? 0,
      });
    }
  }
  return words;
}

/**
 * One box may carry several characters — 你好 arrives 24mm wide, 机机 24.5mm. Divided
 * evenly across x, which is right for the square, evenly-spaced cells of a 字帖 grid.
 *
 * Split by code point: an extension-plane character occupies two UTF-16 units, and
 * dividing by `.length` would cut one in half.
 */
export function splitWideBox(word: RecognisedWord): RecognisedWord[] {
  const chars = [...word.label];
  if (chars.length <= 1) return [word];

  const each = word.width / chars.length;
  return chars.map((label, i) => ({
    label,
    x: word.x + i * each,
    y: word.y,
    width: each,
    height: word.height,
  }));
}

export function readNote(bytes: Buffer): ParsedNote {
  if (bytes.length < SIGNATURE.length + 4 ||
      bytes.subarray(0, SIGNATURE.length).toString('utf8') !== SIGNATURE) {
    throw new Error('These bytes are not a Supernote .note file.');
  }

  const footer = textBlockAt(bytes, bytes.readUInt32LE(bytes.length - 4));

  const pages: ParsedPage[] = [];
  for (let i = 1; ; i += 1) {
    const address = footer.get(`PAGE${i}`);
    if (address === undefined) break;

    const page = textBlockAt(bytes, Number(address));

    const recognitionAddress = Number(page.get('RECOGNTEXT') ?? 0);
    const recognition =
      recognitionAddress > 0 ? parseRecognition(blockAt(bytes, recognitionAddress)) : null;

    let writing: Buffer | null = null;
    const mainAddress = Number(page.get('MAINLAYER') ?? 0);
    if (mainAddress > 0) {
      const bitmapAddress = Number(textBlockAt(bytes, mainAddress).get('LAYERBITMAP') ?? 0);
      if (bitmapAddress > 0) writing = blockAt(bytes, bitmapAddress);
    }

    const pathAddress = Number(page.get('TOTALPATH') ?? 0);
    const strokes = pathAddress > 0 ? parseTotalPath(blockAt(bytes, pathAddress)).strokes : undefined;

    pages.push({ recognition, writing, ...(strokes === undefined ? {} : { strokes }) });
  }

  return { pages };
}
