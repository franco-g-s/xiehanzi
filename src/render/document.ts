/**
 * The one HTML document a sheet is printed from, and the page frame every kind of page
 * shares.
 *
 * Each renderer used to return a complete document and `cmdGenerate` concatenated them.
 * A browser parses that as ONE document with three `<style>` blocks, so the rules merged:
 * recall's absolutely-positioned `.page-head` quietly took over the drill page's header,
 * which left the flow and let row 1 print on top of it. Composition happens here instead —
 * one document, one `<style>`, each renderer contributing only its own namespaced rules,
 * so the same class name can never mean two things.
 *
 * `.page` is the single deliberate exception: it is the shared page box, because
 * `bitmap.ts` finds pages with `page.locator('.page')` and `pdf.ts` prints the same box.
 * It therefore carries ONLY the box — size, overflow, page break, positioning context.
 * Anything a particular kind of page wants on top of that (the drill's padding, say) goes
 * on a modifier class beside it.
 */

import type { SheetConfig } from './layout.js';

export const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Rules shared by every page, and nothing else. No renderer may redefine these — see
 * document.test.ts, which fails if any of them does.
 */
export function frameStyles(config: SheetConfig): string {
  return `
@page { size: ${config.pageWidthMm}mm ${config.pageHeightMm}mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "LXGW WenKai", "Kaiti SC", "STKaiti", serif;
  color: #000; background: #fff;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.page {
  position: relative;
  width: ${config.pageWidthMm}mm; height: ${config.pageHeightMm}mm;
  page-break-after: always; overflow: hidden;
}
.page:last-child { page-break-after: auto; }
`.trim();
}

export function composeDocument(args: {
  title: string;
  styles: readonly string[];
  body: string;
}): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>${escape(args.title)}</title>
<style>${args.styles.join('\n')}</style>
</head><body>${args.body}</body></html>`;
}
