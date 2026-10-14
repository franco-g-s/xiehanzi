/**
 * Writes Supernote `.note` files.
 *
 * No library writes this format — they all read it — so this is built against the parser
 * as specification, and every field is copied from a real device-written note.
 *
 * Container layout, confirmed by dissecting a note the Manta produced:
 *
 *   [0, 24)          signature, `noteSN_FILE_VER_20260016`
 *   ...              blocks, each `[uint32 LE length][content]`, at absolute addresses
 *   footer block     `<PAGE1:addr>...<FILE_FEATURE:headerAddr>...`
 *   "tail"           four literal bytes
 *   last 4 bytes     uint32 LE address of the footer
 *
 * Addresses are absolute, so blocks may appear in any order as long as every reference
 * points at the right byte. Content blocks are written first, then the things that
 * reference them.
 */

import { createHash } from 'node:crypto';
import { blankLayer } from './rle.js';

export const SIGNATURE = 'noteSN_FILE_VER_20260016';
export const TAIL = 'tail';

/** Manta. The parser keys page size off this exact string. */
export const EQUIPMENT = 'N5';
export const PAGE_WIDTH = 1920;
export const PAGE_HEIGHT = 2560;

/**
 * Copied verbatim from a device note. The inner JSON uses `#` where it would otherwise
 * use `:`, because `:` would terminate the tag.
 */
/** Layer 1 now carries the sheet, so it is present and visible rather than deleted. */
const LAYER_INFO =
  '[{"layerId"#3,"name"#"Layer 3","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#true,"isAllowUp"#false,"isAllowDown"#false},' +
  '{"layerId"#2,"name"#"Layer 2","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#true,"isAllowUp"#false,"isAllowDown"#false},' +
  '{"layerId"#1,"name"#"Layer 1","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#false,"isAllowUp"#false,"isAllowDown"#false},' +
  '{"layerId"#0,"name"#"Main Layer","isBackgroundLayer"#false,"isAllowAdd"#false,"isCurrentLayer"#true,"isVisible"#true,"isDeleted"#false,"isAllowUp"#false,"isAllowDown"#false},' +
  '{"layerId"#-1,"name"#"Background Layer","isBackgroundLayer"#true,"isAllowAdd"#true,"isCurrentLayer"#false,"isVisible"#true,"isDeleted"#false,"isAllowUp"#false,"isAllowDown"#false}]';

/**
 * The sheet does NOT live in the background layer, and this is the third attempt at it.
 *
 * PAGESTYLE is not a label: the device resolves it against its own template store and
 * treats what it finds as authoritative.
 *
 *   A custom name         it hunts for a template that does not exist and hangs on
 *                         "loading", with the note unopenable.
 *   A built-in name       it eventually REWRITES the file, replacing our embedded
 *                         background with its own template of that name. Observed live:
 *                         a page declaring style_white_a5x2 came back with its 271 KB
 *                         sheet swapped for the device's 600-byte blank.
 *
 * There is no safe name, so the background layer is the wrong home. The sheet is drawn
 * into LAYER1 instead — ordinary ink, which the device has no opinion about — and BGLAYER
 * is left as the genuine blank white template it claims to be. Writing goes to MAINLAYER,
 * stacked above.
 */
export const BUILTIN_STYLE = 'style_white_a5x2';

export type NotePageInput = {
  /** RLE-encoded sheet for this page. Drawn into LAYER1, not the background. */
  background: Buffer;
  /**
   * Existing handwriting to carry into MAINLAYER. Used when rebuilding a note that has
   * already been written in — repairing one must never cost the practice in it.
   */
  writing?: Buffer;
  styleName?: string;
};

export type WriteNoteOptions = {
  /**
   * Makes the note a real-time recognition note, so the device transcribes handwriting as
   * it is written and stores per-character labels with bounding boxes inside the file.
   * Two header fields are the entire difference; everything else is output the device
   * fills in itself.
   */
  recognitionLanguage?: string;
  /**
   * Makes the file byte-reproducible: the same seed always yields the same identifiers,
   * and therefore the same bytes.
   *
   * This matters beyond tests. Push compares checksums to decide whether a remote sheet
   * has been written on, so a regenerated file that differed only by a random id would be
   * mistaken for handwriting and refused.
   */
  seed?: string;
  now?: () => Date;
  randomSuffix?: () => string;
};

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function defaultSuffix(): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
  }
  return out;
}

/** Twelve alphanumerics derived from the seed, so the same sheet always gets the same id. */
function seededSuffix(seed: string, index: number): string {
  const digest = createHash('sha256').update(`${seed}:${index}`).digest();
  let out = '';
  for (let i = 0; i < 12; i += 1) out += ALPHANUM[digest[i]! % ALPHANUM.length];
  return out;
}

/** `F` or `P` + 20 digits of timestamp + 12 alphanumerics, as the device writes them. */
function makeId(prefix: 'F' | 'P', now: Date, seq: number, suffix: string): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}` +
    `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}` +
    `${pad(now.getMilliseconds(), 3)}${pad(seq, 3)}`;
  return `${prefix}${stamp}${suffix}`;
}

const tag = (key: string, value: string | number): string => `<${key}:${value}>`;

/** Accumulates blocks and hands back the absolute address of each. */
class BlockWriter {
  private readonly parts: Buffer[] = [];
  private offset: number;

  constructor(head: Buffer) {
    this.parts.push(head);
    this.offset = head.length;
  }

  /** Appends `[uint32 LE length][content]` and returns where the block starts. */
  add(content: Buffer): number {
    const address = this.offset;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(content.length, 0);
    this.parts.push(header, content);
    this.offset += 4 + content.length;
    return address;
  }

  addText(content: string): number {
    return this.add(Buffer.from(content, 'utf8'));
  }

  /** The content of a block already written, for de-duplication. */
  blockAt(address: number): Buffer {
    const flat = Buffer.concat(this.parts);
    const length = flat.readUInt32LE(address);
    return flat.subarray(address + 4, address + 4 + length);
  }

  appendRaw(bytes: Buffer): void {
    this.parts.push(bytes);
    this.offset += bytes.length;
  }

  get length(): number {
    return this.offset;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export function writeNote(
  pages: readonly NotePageInput[],
  options: WriteNoteOptions = {},
): Buffer {
  if (pages.length === 0) throw new Error('A note needs at least one page.');

  // A seeded note fixes the clock too: a timestamp in the id would otherwise still vary.
  const now =
    options.seed !== undefined && options.now === undefined
      ? new Date(0)
      : (options.now?.() ?? new Date());

  let counter = 0;
  const suffix =
    options.randomSuffix ??
    (options.seed !== undefined
      ? () => seededSuffix(options.seed!, counter++)
      : defaultSuffix);

  const writer = new BlockWriter(Buffer.from(SIGNATURE, 'utf8'));

  // Content first: everything below only stores addresses into it.
  // One empty writing layer serves every page — nothing has been written yet.
  const emptyLayerAddress = writer.add(blankLayer(PAGE_WIDTH, PAGE_HEIGHT));

  // Every page genuinely uses the blank template now, so they can all name it honestly
  // and share one style entry. The sheet is ink in LAYER1, below.
  const styleName = BUILTIN_STYLE;
  const blankBackground = blankLayer(PAGE_WIDTH, PAGE_HEIGHT);
  const backgroundAddress = writer.add(blankBackground);
  const styleAddresses = new Map<string, number>([[styleName, backgroundAddress]]);

  // One block per distinct sheet; identical pages share.
  const sheetAddresses = new Map<string, number>();
  const pageSheetAddresses = pages.map((page) => {
    const key = createHash('sha256').update(page.background).digest('hex');
    const existing = sheetAddresses.get(key);
    if (existing !== undefined) return existing;
    const address = writer.add(page.background);
    sheetAddresses.set(key, address);
    return address;
  });

  const layerBlock = (name: string, bitmapAddress: number): string =>
    tag('LAYERTYPE', 'NOTE') +
    tag('LAYERPROTOCOL', 'RATTA_RLE') +
    tag('LAYERNAME', name) +
    tag('LAYERPATH', 0) +
    tag('LAYERBITMAP', bitmapAddress) +
    tag('LAYERVECTORGRAPH', 0) +
    tag('LAYERRECOGN', 0);

  const writingAddresses = pages.map((page) =>
    page.writing === undefined ? emptyLayerAddress : writer.add(page.writing),
  );

  const pageAddresses = pages.map((_page, index) => {
    const mainAddress = writer.addText(layerBlock('MAINLAYER', writingAddresses[index]!));
    const sheetAddress = writer.addText(layerBlock('LAYER1', pageSheetAddresses[index]!));
    const bgAddress = writer.addText(layerBlock('BGLAYER', backgroundAddress));

    return writer.addText(
      tag('PAGESTYLE', styleName) +
        tag('PAGESTYLEMD5', 0) +
        tag('LAYERINFO', LAYER_INFO) +
        // Writing on top, the sheet beneath it, blank paper at the bottom.
        tag('LAYERSEQ', 'MAINLAYER,LAYER1,BGLAYER') +
        tag('MAINLAYER', mainAddress) +
        tag('LAYER1', sheetAddress) +
        tag('LAYER2', 0) +
        tag('LAYER3', 0) +
        tag('BGLAYER', bgAddress) +
        tag('TOTALPATH', 0) +
        tag('THUMBNAILTYPE', 0) +
        tag('RECOGNSTATUS', 0) +
        tag('RECOGNTEXT', 0) +
        tag('RECOGNFILE', 0) +
        tag('PAGEID', makeId('P', now, index, suffix())) +
        tag('RECOGNTYPE', 0) +
        tag('RECOGNFILESTATUS', 0) +
        tag('RECOGNLANGUAGE', 'none') +
        tag('EXTERNALLINKINFO', 0) +
        tag('IDTABLE', 0) +
        tag('ORIENTATION', 1000) +
        tag('PAGETEXTBOX', 0) +
        tag('DISABLE', 'none'),
    );
  });

  const headerAddress = writer.addText(
    tag('MODULE_LABEL', 'none') +
      tag('FILE_TYPE', 'NOTE') +
      tag('APPLY_EQUIPMENT', EQUIPMENT) +
      tag('FINALOPERATION_PAGE', 1) +
      tag('FINALOPERATION_LAYER', 1) +
      tag('DEVICE_DPI', 0) +
      tag('SOFT_DPI', 0) +
      tag('FILE_PARSE_TYPE', 0) +
      tag('RATTA_ETMD', 0) +
      tag('APP_VERSION', 0) +
      tag('FILE_ID', makeId('F', now, 0, suffix())) +
      tag('FILE_RECOGN_TYPE', options.recognitionLanguage === undefined ? 0 : 1) +
      tag('FILE_RECOGN_LANGUAGE', options.recognitionLanguage ?? 'none') +
      tag('PDFSTYLE', 'none') +
      tag('PDFSTYLEMD5', 0) +
      tag('STYLEUSAGETYPE', 0) +
      tag('HIGHLIGHTINFO', 0) +
      tag('HORIZONTAL_CHECK', 0) +
      tag('IS_OLD_APPLY_EQUIPMENT', 1) +
      tag('ANTIALIASING_CONVERT', 2),
  );

  let footer = pageAddresses.map((address, i) => tag(`PAGE${i + 1}`, address)).join('');
  footer += tag('COVER_0', 0) + tag('DIRTY', 0) + tag('FILE_FEATURE', headerAddress);
  for (const [name, address] of styleAddresses) footer += tag(`STYLE_${name}`, address);

  const footerAddress = writer.addText(footer);

  writer.appendRaw(Buffer.from(TAIL, 'utf8'));
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32LE(footerAddress, 0);
  writer.appendRaw(trailer);

  return writer.toBuffer();
}
