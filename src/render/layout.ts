/**
 * Sheet layout: a fully-resolved plan in, print-exact HTML out.
 *
 * No lookups happen here — the plan already carries pinyin, meanings and examples, so the
 * layout is pure and testable without the dictionary or stroke dataset.
 *
 * Every dimension is in millimetres, because the output is a PDF that must land at exact
 * physical size on the Supernote rather than being scaled to fit.
 */

import type { CharacterPlan } from '../select/enrich.js';
import { loadGlyph, strokeFilmstrip, glyphPaths, GLYPH_TRANSFORM, MODEL_VIEWBOX } from './glyph.js';
import { composeDocument, escape, frameStyles } from './document.js';

// Re-exported because half the render layer already imports it from here, and moving the
// definition to document.js should not force every caller to learn where it went.
export { escape };

export type SheetConfig = {
  pageWidthMm: number;
  pageHeightMm: number;
  /** Asymmetric on purpose — see DEFAULT_SHEET_CONFIG. */
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  /** Everything else is derived from this. */
  rowsPerPage: number;
  /** Unused width kept clear at the end of each row. */
  rowEndSpaceMm: number;
  filmstripMm: number;
  headerMm: number;
  exampleMm: number;
  gapMm: number;
  pageHeaderMm: number;
  gridStyle: 'mizige' | 'tianzige';
};

/**
 * Supernote Manta: 1920×2560 at ~299 DPI.
 *
 * The margins are uneven to dodge the device's own furniture: the toolbar sits down the
 * left edge, so that side gets extra clearance and the top gives some back. The bottom used
 * to be widened for the same reason; it is not any more — see marginBottomMm.
 */
export const DEFAULT_SHEET_CONFIG: SheetConfig = {
  pageWidthMm: 162.6,
  pageHeightMm: 216.7,
  marginTopMm: 5,
  // 8mm: an ordinary page margin, in the same range as the 6mm on the right. This was 18,
  // sized so the device's page-navigation strip could not clip the last row's example line.
  // Franco has hidden that strip, so there is nothing down there to clear and the 10mm goes
  // back to the rows — taller cells, and the recall rows spread out to fill the page.
  marginBottomMm: 8,
  marginLeftMm: 14,
  marginRightMm: 6,
  // 9 rows, and 9 characters a day (DEFAULT_COUNT in generate.ts) — one drill page a day,
  // filled exactly, with no near-empty second page.
  rowsPerPage: 9,
  rowEndSpaceMm: 3,
  // Row furniture is deliberately tight. Fitting a ninth row by shrinking the cells would
  // undo the size Franco just confirmed works, so the space comes out of the padding
  // between rows instead: 8mm of furniture holds the cell at ~12.8mm.
  filmstripMm: 3.8,
  headerMm: 4.9,
  exampleMm: 4.2,
  gapMm: 0.3,
  pageHeaderMm: 6,
  gridStyle: 'mizige',
};

/** Below this a cell is too small to write in; better to fail than emit an unusable sheet. */
const MIN_CELL_MM = 6;

/**
 * Held back from the row budget so accumulated rounding cannot push the final row past the
 * page edge and clip it.
 */
const VERTICAL_SAFETY_MM = 0.5;

export type SheetMetrics = {
  usableWidthMm: number;
  usableHeightMm: number;
  blockHeightMm: number;
  cellMm: number;
  /** Practice cells per row — derived, not configured. */
  repetitions: number;
};

/**
 * Everything follows from `rowsPerPage`.
 *
 * Fewer rows means taller blocks, which means bigger cells, which means fewer of them fit
 * across the page. Deriving both dimensions from one number keeps the sheet from ever
 * overflowing, and makes "make the cells bigger" a single-knob change.
 */
export function computeMetrics(config: SheetConfig): SheetMetrics {
  const usableWidthMm = config.pageWidthMm - config.marginLeftMm - config.marginRightMm;
  const usableHeightMm =
    config.pageHeightMm - config.marginTopMm - config.marginBottomMm - config.pageHeaderMm;

  const blockHeightMm = (usableHeightMm - VERTICAL_SAFETY_MM) / config.rowsPerPage;
  const cellMm = blockHeightMm - config.headerMm - config.exampleMm - config.gapMm;

  if (cellMm < MIN_CELL_MM) {
    throw new Error(
      `rowsPerPage=${config.rowsPerPage} leaves only ${cellMm.toFixed(1)}mm per cell, ` +
        `below the ${MIN_CELL_MM}mm minimum. Use fewer rows per page.`,
    );
  }

  const repetitions = Math.floor((usableWidthMm - config.rowEndSpaceMm) / cellMm);
  if (repetitions < 1) {
    throw new Error(
      `A ${cellMm.toFixed(1)}mm cell does not fit in ${usableWidthMm.toFixed(1)}mm of usable width.`,
    );
  }

  return { usableWidthMm, usableHeightMm, blockHeightMm, cellMm, repetitions };
}

/** One cell is 100 units square in the row's own coordinate space. */
const CELL_UNITS = 100;

/**
 * The whole row of cells as a SINGLE svg.
 *
 * Drawing one svg per cell let sub-pixel rounding accumulate, which showed up in print as
 * a row split into blocks of 6 + 4 + 4 with visible seams. One element, one coordinate
 * space, no seams.
 */
function rowGrid(
  columns: number,
  style: SheetConfig['gridStyle'],
  glyph: ReturnType<typeof loadGlyph>,
  fallbackChar: string,
): string {
  const w = columns * CELL_UNITS;
  // A stroke straddles the path it is drawn on, so a border at x=0 loses its outer half to
  // the viewBox edge. Inset the frame by half its own width so it is fully inside.
  const border = 2;
  const half = border / 2;

  const dividers: string[] = [];
  for (let i = 1; i < columns; i += 1) {
    dividers.push(`M${i * CELL_UNITS} 0 V${CELL_UNITS}`);
  }

  const inner: string[] = [];
  for (let i = 0; i < columns; i += 1) {
    const x = i * CELL_UNITS;
    inner.push(`M${x + 50} 0 V${CELL_UNITS}`, `M${x} 50 H${x + CELL_UNITS}`);
    if (style === 'mizige') {
      inner.push(`M${x} 0 L${x + CELL_UNITS} ${CELL_UNITS}`, `M${x + CELL_UNITS} 0 L${x} ${CELL_UNITS}`);
    }
  }

  // The model character sits in the first cell only. No fade across later cells: it eats
  // space, and the faintest steps do not survive e-ink rendering anyway.
  const model =
    glyph !== null
      ? `<svg x="0" y="0" width="${CELL_UNITS}" height="${CELL_UNITS}" viewBox="${MODEL_VIEWBOX}">` +
        `<g transform="${GLYPH_TRANSFORM}">${glyphPaths(glyph, { fill: '#000' })}</g></svg>`
      : `<text x="${CELL_UNITS / 2}" y="${CELL_UNITS * 0.78}" font-size="${CELL_UNITS * 0.8}" ` +
        `text-anchor="middle" fill="#000">${escape(fallbackChar)}</text>`;

  return (
    `<svg class="grid" viewBox="0 0 ${w} ${CELL_UNITS}" preserveAspectRatio="none">` +
    `<path d="${inner.join(' ')}" stroke="#d5d5d5" stroke-width="0.8" stroke-dasharray="4 4" fill="none"/>` +
    `<path d="${dividers.join(' ')}" stroke="#8f8f8f" stroke-width="1" fill="none"/>` +
    `<rect x="${half}" y="${half}" width="${w - border}" height="${CELL_UNITS - border}" ` +
    `fill="none" stroke="#8f8f8f" stroke-width="${border}"/>` +
    model +
    `</svg>`
  );
}

function row(charPlan: CharacterPlan, config: SheetConfig, m: SheetMetrics): string {
  const glyph = loadGlyph(charPlan.char);

  const strokes =
    glyph === null
      ? '<span class="no-strokes">no stroke data</span>'
      : `<span class="filmstrip">${strokeFilmstrip(glyph, {
          sizeMm: config.filmstripMm,
          maxFrames: 20,
        })}</span>`;

  // Stroke count deliberately omitted: the filmstrip already shows every stroke.
  const meta = [charPlan.pinyin, charPlan.meaning]
    .filter((s) => s !== '')
    .map(escape)
    .join(' · ');

  const foot =
    charPlan.example === undefined
      ? '<div class="row-foot"></div>'
      : `<div class="row-foot"><b>${escape(charPlan.example.term)}</b> ` +
        `<i>${escape(charPlan.example.pinyin)}</i> — ${escape(charPlan.example.meaning)}</div>`;

  return (
    `<div class="row">` +
    `<div class="row-head"><span class="meta">${meta}</span>${strokes}</div>` +
    `<div class="cells">${rowGrid(m.repetitions, config.gridStyle, glyph, charPlan.char)}</div>` +
    foot +
    `</div>`
  );
}

/**
 * The drill pages' own rules. Everything shared with the other page kinds — the page box,
 * `@page`, the body font — belongs to `frameStyles` and must not be repeated here: two
 * stylesheets claiming one selector is the bug this split exists to prevent.
 */
export function sheetStyles(config: SheetConfig, m: SheetMetrics): string {
  const gridWidthMm = m.repetitions * m.cellMm;
  return `
/* Padding lives on the modifier, not on .page: absolutely positioned children of a recall
   page resolve against the padding box, so a shared .page padding would silently shift
   every graded recall cell. */
.page-drill {
  padding: ${config.marginTopMm}mm ${config.marginRightMm}mm ${config.marginBottomMm}mm ${config.marginLeftMm}mm;
}
.page-head {
  height: ${config.pageHeaderMm}mm; display: flex; justify-content: space-between;
  align-items: baseline; font-size: 3mm; color: #666;
  border-bottom: 0.2mm solid #ddd; margin-bottom: 1mm;
}
.row { height: ${m.blockHeightMm.toFixed(3)}mm; overflow: hidden; }
.row-head {
  height: ${config.headerMm}mm; width: ${gridWidthMm.toFixed(3)}mm;
  display: flex; align-items: center; gap: 2mm;
  /* line-height pinned to the box: a taller line box would be clipped by overflow. */
  font-size: 2.8mm; line-height: ${config.headerMm}mm;
  color: #333; overflow: hidden; white-space: nowrap;
}
.row-head .meta {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* flex-shrink 0: a long gloss must ellipsize rather than shove the strokes off the row. */
.filmstrip { flex: 0 0 auto; display: flex; align-items: center; gap: 0.3mm; }
.no-strokes { font-size: 2.6mm; color: #b00; font-style: italic; }
.cells { height: ${m.cellMm.toFixed(3)}mm; width: ${gridWidthMm.toFixed(3)}mm; }
.grid { display: block; width: 100%; height: 100%; }
.row-foot {
  height: ${config.exampleMm}mm; width: ${gridWidthMm.toFixed(3)}mm;
  font-size: 2.7mm; line-height: ${config.exampleMm}mm;
  color: #444; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.row-foot i { color: #777; font-style: normal; }
`.trim();
}

export type SheetMeta = {
  date: string;
  mode: string;
};

/** Just the drill pages — no document, no styles. See document.ts for why. */
export function sheetFragment(
  plans: readonly CharacterPlan[],
  meta: SheetMeta,
  config: SheetConfig = DEFAULT_SHEET_CONFIG,
  metrics: SheetMetrics = computeMetrics(config),
): string {
  const pages: CharacterPlan[][] = [];
  for (let i = 0; i < plans.length; i += config.rowsPerPage) {
    pages.push(plans.slice(i, i + config.rowsPerPage));
  }
  if (pages.length === 0) pages.push([]);

  return pages
    .map((page, i) => {
      const head =
        `<div class="page-head"><span>写汉字 · ${escape(meta.date)}</span>` +
        `<span>${escape(meta.mode)} · ${i + 1}/${pages.length}</span></div>`;
      return (
        `<div class="page page-drill">${head}` +
        page.map((p) => row(p, config, metrics)).join('') +
        `</div>`
      );
    })
    .join('');
}

/** The drill pages as a standalone document — a sheet with no recall half. */
export function renderSheet(
  plans: readonly CharacterPlan[],
  meta: SheetMeta,
  config: SheetConfig = DEFAULT_SHEET_CONFIG,
): string {
  const m = computeMetrics(config);
  return composeDocument({
    title: `写汉字 ${meta.date}`,
    styles: [frameStyles(config), sheetStyles(config, m)],
    body: sheetFragment(plans, meta, config, m),
  });
}
