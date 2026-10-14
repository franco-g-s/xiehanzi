/**
 * HTML → PDF at exact physical size.
 *
 * The page must land on the Supernote at true millimetre scale, so the PDF box is set
 * explicitly rather than letting the browser scale to fit a paper size.
 */

import { chromium, type Browser } from 'playwright';
import type { SheetConfig } from './layout.js';
import { DEFAULT_SHEET_CONFIG } from './layout.js';

export type PdfOptions = {
  config?: SheetConfig;
  /** Reuse a browser across several sheets. */
  browser?: Browser;
};

export async function renderPdf(
  html: string,
  outputPath: string,
  options: PdfOptions = {},
): Promise<void> {
  const config = options.config ?? DEFAULT_SHEET_CONFIG;
  const browser = options.browser ?? (await chromium.launch());
  const ownsBrowser = options.browser === undefined;

  try {
    const page = await browser.newPage();
    // `load` rather than `networkidle`: the page is entirely self-contained, so waiting
    // for network quiet just adds a fixed delay.
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({
      path: outputPath,
      width: `${config.pageWidthMm}mm`,
      height: `${config.pageHeightMm}mm`,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      printBackground: true,
      preferCSSPageSize: true,
    });
    await page.close();
  } finally {
    if (ownsBrowser) await browser.close();
  }
}
