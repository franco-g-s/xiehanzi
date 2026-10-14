import { describe, it, expect } from 'vitest';
import { writeNote, SIGNATURE, TAIL, PAGE_WIDTH, PAGE_HEIGHT, BUILTIN_STYLE } from './write.js';
import { encodeRle, blankLayer, RLE } from './rle.js';
import { SupernoteX } from 'supernote-typescript';

/** A background with a black band across the top, so it is recognisable once decoded. */
function testBackground(): Buffer {
  const px = new Uint8Array(PAGE_WIDTH * PAGE_HEIGHT).fill(RLE.background);
  px.fill(RLE.black, 0, PAGE_WIDTH * 40);
  return encodeRle(px);
}

const fixed = {
  now: () => new Date('2026-08-20T10:00:00Z'),
  randomSuffix: () => 'AAAAAAAAAAAA',
};

const onePage = () => writeNote([{ background: testBackground() }], fixed);

describe('writeNote — container shape', () => {
  const note = onePage();

  it('starts with the signature the parsers require', () => {
    expect(note.subarray(0, 24).toString('utf8')).toBe(SIGNATURE);
  });

  it('ends with the tail marker and the footer address', () => {
    expect(note.subarray(note.length - 8, note.length - 4).toString('utf8')).toBe(TAIL);
    const footerAddress = note.readUInt32LE(note.length - 4);
    expect(footerAddress).toBeGreaterThan(0);
    expect(footerAddress).toBeLessThan(note.length);
  });

  it('points the footer address at a real block', () => {
    const address = note.readUInt32LE(note.length - 4);
    const length = note.readUInt32LE(address);
    const body = note.subarray(address + 4, address + 4 + length).toString('utf8');
    expect(body).toContain('<PAGE1:');
    expect(body).toContain('<FILE_FEATURE:');
  });

  it('is byte-identical when the clock and randomness are fixed', () => {
    expect(onePage().equals(onePage())).toBe(true);
  });
});

describe('writeNote — the real parser must accept it', () => {
  it('parses as a one-page Manta note', () => {
    const note = new SupernoteX(new Uint8Array(onePage()));
    expect(note.pages).toHaveLength(1);
    expect(note.pageWidth).toBe(PAGE_WIDTH);
    expect(note.pageHeight).toBe(PAGE_HEIGHT);
  });

  it('reports the header the device expects', () => {
    const note = new SupernoteX(new Uint8Array(onePage()));
    expect(note.header.FILE_TYPE).toBe('NOTE');
    expect(note.header.APPLY_EQUIPMENT).toBe('N5');
  });

  // LAYERBITMAP holds the ADDRESS as a string; the decoded bytes are in bitmapBuffer.
  // The sheet is ink in LAYER1, not a background. The device rewrites BGLAYER to match
  // whatever template PAGESTYLE names — it replaced a 271 KB sheet with its own 600-byte
  // blank — so nothing we need to keep may live there.
  it('draws the sheet in LAYER1 and leaves the background genuinely blank', () => {
    const page = new SupernoteX(new Uint8Array(onePage())).pages[0]!;
    const blank = blankLayer(PAGE_WIDTH, PAGE_HEIGHT).length;

    expect(page.LAYERSEQ).toEqual(['MAINLAYER', 'LAYER1', 'BGLAYER']);
    expect(page.LAYER1.bitmapBuffer!.length).toBe(testBackground().length);
    expect(page.BGLAYER.bitmapBuffer!.length).toBe(blank);
    expect(page.MAINLAYER.bitmapBuffer!.length).toBe(blank);
  });

  it('stacks writing above the sheet', () => {
    const seq = new SupernoteX(new Uint8Array(onePage())).pages[0]!.LAYERSEQ;
    expect(seq.indexOf('MAINLAYER')).toBeLessThan(seq.indexOf('LAYER1'));
  });

  // A custom PAGESTYLE hangs the device: it resolves the name against its own template
  // store, finds nothing, and sits on "loading" with the note unopenable.
  it('names a style the device already ships', () => {
    const page = new SupernoteX(new Uint8Array(onePage())).pages[0]!;
    expect(page.PAGESTYLE).toBe(BUILTIN_STYLE);
    expect(page.PAGESTYLE).toMatch(/^style_/);
  });

  it('names the blank template honestly, because that is what the background now is', () => {
    const note = writeNote(
      [{ background: testBackground() }, { background: blankLayer(PAGE_WIDTH, PAGE_HEIGHT) }],
      fixed,
    );
    for (const page of new SupernoteX(new Uint8Array(note)).pages) {
      expect(page.PAGESTYLE).toBe(BUILTIN_STYLE);
    }
  });
});

describe('writeNote — multiple pages', () => {
  const note = writeNote(
    [{ background: testBackground() }, { background: blankLayer(PAGE_WIDTH, PAGE_HEIGHT) }],
    fixed,
  );

  it('parses with every page present', () => {
    expect(new SupernoteX(new Uint8Array(note)).pages).toHaveLength(2);
  });

  it('gives each page its own sheet', () => {
    const pages = new SupernoteX(new Uint8Array(note)).pages;
    expect(pages[0]!.LAYER1.bitmapBuffer!.length).not.toBe(pages[1]!.LAYER1.bitmapBuffer!.length);
  });

  it('gives each page a distinct id', () => {
    const pages = new SupernoteX(new Uint8Array(note)).pages;
    expect(pages[0]!.PAGEID).not.toBe(pages[1]!.PAGEID);
  });

  it('stores a shared sheet only once', () => {
    const shared = testBackground();
    const two = writeNote([{ background: shared }, { background: shared }], fixed);
    const pages = new SupernoteX(new Uint8Array(two)).pages;
    expect(pages[0]!.LAYER1.LAYERBITMAP).toBe(pages[1]!.LAYER1.LAYERBITMAP);
  });

  it('refuses to write a note with no pages', () => {
    expect(() => writeNote([], fixed)).toThrow(/at least one page/i);
  });
});

describe('writeNote — reproducibility', () => {
  // Push compares checksums to tell "already delivered" from "written on". A file that
  // differed only by a random id would be mistaken for handwriting and refused.
  it('produces identical bytes for the same seed', () => {
    const a = writeNote([{ background: testBackground() }], { seed: '2026-08-20' });
    const b = writeNote([{ background: testBackground() }], { seed: '2026-08-20' });
    expect(a.equals(b)).toBe(true);
  });

  it('produces different bytes for different seeds', () => {
    const a = writeNote([{ background: testBackground() }], { seed: '2026-08-20' });
    const b = writeNote([{ background: testBackground() }], { seed: '2026-08-21' });
    expect(a.equals(b)).toBe(false);
  });

  it('still gives each page its own id within one seeded note', () => {
    const note = writeNote(
      [{ background: testBackground() }, { background: blankLayer(PAGE_WIDTH, PAGE_HEIGHT) }],
      { seed: '2026-08-20' },
    );
    const pages = new SupernoteX(new Uint8Array(note)).pages;
    expect(pages[0]!.PAGEID).not.toBe(pages[1]!.PAGEID);
  });

  it('varies between runs when no seed is given', () => {
    const a = writeNote([{ background: testBackground() }]);
    const b = writeNote([{ background: testBackground() }]);
    expect(a.equals(b)).toBe(false);
  });

  it('still parses when seeded', () => {
    const note = writeNote([{ background: testBackground() }], { seed: 's' });
    expect(new SupernoteX(new Uint8Array(note)).pages).toHaveLength(1);
  });
});

describe('writeNote — recognition notes', () => {
  // The device transcribes as you write, but only for a note created with these two
  // header fields. An existing note cannot be converted afterwards.
  it('is an ordinary note unless a language is given', () => {
    const note = new SupernoteX(new Uint8Array(writeNote([{ background: testBackground() }], fixed)));
    const header = note.header as unknown as Record<string, string>;
    expect(header.FILE_RECOGN_TYPE).toBe('0');
    expect(header.FILE_RECOGN_LANGUAGE).toBe('none');
  });

  it('becomes a real-time recognition note when one is', () => {
    const note = new SupernoteX(
      new Uint8Array(
        writeNote([{ background: testBackground() }], { ...fixed, recognitionLanguage: 'zh_CN' }),
      ),
    );
    const header = note.header as unknown as Record<string, string>;
    expect(header.FILE_RECOGN_TYPE).toBe('1');
    expect(header.FILE_RECOGN_LANGUAGE).toBe('zh_CN');
  });

  it('still parses and keeps the sheet when recognition is on', () => {
    const note = writeNote([{ background: testBackground() }], { ...fixed, recognitionLanguage: 'zh_CN' });
    const page = new SupernoteX(new Uint8Array(note)).pages[0]!;
    expect(page.LAYER1.bitmapBuffer!.length).toBe(testBackground().length);
  });
});

describe('writeNote — carrying existing handwriting', () => {
  // Repairing a note must never cost the practice already in it.
  it('keeps supplied strokes in MAINLAYER instead of blanking it', () => {
    const strokes = encodeRle(
      (() => {
        const px = new Uint8Array(PAGE_WIDTH * PAGE_HEIGHT).fill(RLE.background);
        px.fill(RLE.black, PAGE_WIDTH * 300, PAGE_WIDTH * 320);
        return px;
      })(),
    );
    const note = writeNote([{ background: testBackground(), writing: strokes }], fixed);
    const page = new SupernoteX(new Uint8Array(note)).pages[0]!;

    expect(page.MAINLAYER.bitmapBuffer!.length).toBe(strokes.length);
    expect(page.LAYER1.bitmapBuffer!.length).toBe(testBackground().length);
  });

  it('still blanks MAINLAYER for a fresh sheet', () => {
    const page = new SupernoteX(new Uint8Array(onePage())).pages[0]!;
    expect(page.MAINLAYER.bitmapBuffer!.length).toBe(blankLayer(PAGE_WIDTH, PAGE_HEIGHT).length);
  });
});
