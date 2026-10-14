/**
 * Renders sheet HTML to device-resolution bitmaps, RLE-encoded for a `.note` background.
 *
 * The Manta's screen is 1920x2560, and a `.note` background layer must be exactly that, so
 * pages are rasterised at device scale and resized to the exact dimensions rather than
 * trusting CSS rounding to land on them.
 */

import { chromium, type Browser } from 'playwright';
import { decodePng, resize } from 'image-js';
import { encodeRle, greyToPalette } from '../deliver/note/rle.js';
import { PAGE_WIDTH, PAGE_HEIGHT } from '../deliver/note/write.js';

const MM_PER_INCH = 25.4;
const CSS_PPI = 96;

export type BitmapOptions = {
  pageWidthMm: number;
  pageHeightMm: number;
  browser?: Browser;
};

/** Converts an RGBA raster to one palette code per pixel. */
export function rasterToPalette(rgba: Uint8Array | Uint8ClampedArray, channels: number): Uint8Array {
  const out = new Uint8Array(rgba.length / channels);
  for (let i = 0, p = 0; i < rgba.length; i += channels, p += 1) {
    // Luma from the visible channels; the sheet is greyscale so a simple average is exact.
    const grey = (rgba[i]! + rgba[i + 1]! + rgba[i + 2]!) / 3;
    out[p] = greyToPalette(grey);
  }
  return out;
}

/** One RLE-encoded background per page of the sheet. */
export async function renderPageBitmaps(
  html: string,
  options: BitmapOptions,
): Promise<Buffer[]> {
  const cssWidth = (options.pageWidthMm / MM_PER_INCH) * CSS_PPI;
  const cssHeight = (options.pageHeightMm / MM_PER_INCH) * CSS_PPI;

  const browser = options.browser ?? (await chromium.launch());
  const ownsBrowser = options.browser === undefined;

  try {
    const context = await browser.newContext({
      viewport: { width: Math.ceil(cssWidth), height: Math.ceil(cssHeight) },
      // Enough to exceed 1920 across, so the resize below only ever shrinks.
      deviceScaleFactor: PAGE_WIDTH / cssWidth + 0.01,
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });

    const elements = await page.locator('.page').all();
    const out: Buffer[] = [];

    for (const element of elements) {
      const shot = await element.screenshot({ type: 'png' });
      const decoded = decodePng(shot);
      const image = resize(decoded, { width: PAGE_WIDTH, height: PAGE_HEIGHT });
      out.push(encodeRle(rasterToPalette(image.getRawImage().data as Uint8Array, image.channels)));
    }

    await context.close();
    return out;
  } finally {
    if (ownsBrowser) await browser.close();
  }
}
