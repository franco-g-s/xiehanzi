/**
 * Recall rows and their solutions page: a cue with the answer blanked out, followed by
 * empty practice cells.
 *
 * The drill sheet shows a model glyph and grades nothing; recall shows no model and its
 * whole point is to be graded, so the geometry it produces is durable — stored on the
 * manifest (`RecallGeometry` in `../state/sheets.js`) and read back later to map ink on the
 * page to the character it was meant to answer. That is also why `originYMm` marks the top
 * of the *cells*, not the row: grading must never mistake cue text for an attempt.
 */

import type { SheetConfig } from './layout.js';
import { computeMetrics } from './layout.js';
import { composeDocument, escape, frameStyles } from './document.js';
import { loadGlyph, glyphPaths, strokeFilmstrip, GLYPH_TRANSFORM, MODEL_VIEWBOX } from './glyph.js';
import type { Example } from '../select/enrich.js';
import type { RecallGeometry } from '../state/sheets.js';

export type CueStyle = 'gap' | 'plain';

export type RecallConfig = {
  cueStyle: CueStyle;
  /** How many due-review pages the caller wants; unused by layout, kept for callers upstream. */
  pages: number;
  cellsPerRow: number;
  cueMm: number;
  gapMm: number;
  /**
   * Blank space between the first cell and the rest of the row.
   *
   * Cell 1 is the one graded attempt and is never erased; the cells after it are written
   * only once the answer has been checked. They are different exercises, so they are set
   * apart on the page rather than reading as one uninterrupted strip.
   */
  firstCellGapMm: number;
};

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  cueStyle: 'gap',
  // Two pages, ~20 items a day, against an intake of 9 new characters a day. At one page
  // the recall queue grew by roughly 8 a day: a character's first recall test, nominally
  // scheduled for the day after it was drilled, actually landed 3-5 days later, and
  // measured retention at those lags was 75% / 42% / 25%. Capacity has to exceed intake or
  // the backlog — not the difficulty — is what sets the pass rate.
  pages: 2,
  cellsPerRow: 6,
  cueMm: 4.4,
  gapMm: 0.3,
  firstCellGapMm: 2.5,
};

export type RecallPlan = {
  char: string;
  pinyin: string;
  meaning: string;
  // `| undefined` spelled out (not just `?`) so that `Partial<RecallPlan>` — as the test
  // helper's `over` uses — still accepts an explicit `example: undefined` override under
  // `exactOptionalPropertyTypes`. Plain `example?: Example` loses this once wrapped in
  // `Partial`.
  example?: Example | undefined;
  /**
   * Overrides `buildCue`'s own computation with an already-decided cue — set when a
   * manifest already carries this row (regenerating an existing date reuses its rows
   * rather than recomputing), so the printed page always matches the manifest exactly
   * regardless of whether the dictionary or example data has since changed.
   */
  cue?: string;
};

export type { RecallGeometry };

/** U+FF3F FULLWIDTH LOW LINE — an ordinary underscore reads as punctuation mid-word in CJK. */
const GAP_CHAR = '＿';

/** Every occurrence of `char` in `text`, replaced with the gap marker. */
const blank = (text: string, char: string): string => text.split(char).join(GAP_CHAR);

/** Every occurrence of every char in `targets`, replaced with the gap marker. */
const blankAll = (text: string, targets: Iterable<string>): string => {
  let out = text;
  for (const char of targets) out = blank(out, char);
  return out;
};

/**
 * The cue must never admit two right answers. Automatic grading means an ambiguous cue
 * marks a correct write wrong, and a false failure feeds straight into the recall schedule
 * as if the character had actually been forgotten — so this function's one job is to make
 * sure the thing it prints identifies exactly one character.
 *
 * `gap` blanks every occurrence of the target inside its example word and cues with the
 * word's own pinyin and meaning, never the bare character's — the bare-character reading
 * can differ from how it is read inside the word, and printing it would leak a second,
 * wrong answer alongside the right one. With no example word there is nothing to blank, so
 * it falls back to the bare character (still never a hanzi glyph, only its reading).
 *
 * A CC-CEDICT gloss routinely names its own headword — "variant of 公布", "see 咱",
 * "(abbr. for 交通警察)" — because it is prose about the word, not just a translation of
 * it. A scan of all 1,200 handwriting characters through this function found 15 such
 * leaks, all from an unblanked meaning. So the meaning gets the exact same blanking as the
 * example word: the word's meaning in `gap` (matching the word's own term/pinyin), the
 * character's own meaning in the fallback (matching its own pinyin). A gloss that blanks
 * down to "see ＿" carries less information than before, but a cue that names its own
 * answer is worse than no cue at all — it corrupts the grading, not just weakens it.
 *
 * `sheetAnswers`, when given, widens that to every answer on the sheet, not just this row's
 * own. Characters due the same day come from the same drill sheet, so their HSK example
 * words overlap constantly — 他们/你们/我们 all contain 们 — and a row's cue can print the
 * *answer to a different row* even while correctly blanking its own target. Optional, and
 * defaulting to just this row's character, so direct callers (including the existing
 * tests) that only care about one row's own leak keep working unchanged; `renderRecallPages`
 * is the one place that actually has "every answer on the sheet" to hand, and passes it.
 */
export function buildCue(plan: RecallPlan, style: CueStyle, sheetAnswers?: ReadonlySet<string>): string {
  const targets = new Set<string>(sheetAnswers);
  targets.add(plan.char);

  if (style === 'gap' && plan.example !== undefined) {
    const blankedTerm = blankAll(plan.example.term, targets);
    const blankedMeaning = blankAll(plan.example.meaning, targets);
    return (
      `${escape(blankedTerm)} <i>${reading(plan.example, plan.char)}</i> — ${escape(blankedMeaning)}`
    );
  }
  const blankedMeaning = blankAll(plan.meaning, targets);
  // One syllable, and it is the target's, so all of it is emboldened — the two cue styles
  // then mark the answer's reading the same way.
  return `<b>${escape(plan.pinyin)}</b> · ${escape(blankedMeaning)}`;
}

/**
 * The example word's reading, with the blanked character's own syllable emboldened.
 *
 * "城＿ chéngshì — city" names the word but not which half of it is missing, and 城市 is
 * exactly as good a prompt for 城 as it is for 市. On a day both are due — and they will be,
 * since same-day characters come off the same drill sheet — the reader has no way to tell
 * the two rows apart, and grading maps each row to the character the manifest recorded for
 * it. Emboldening the target's syllable is what turns the cue back into one question.
 *
 * Mapping hanzi to syllable by index only holds when there is one of each. Erhua ("一下儿",
 * two syllables over three characters) and a handful of other entries break it, and bolding
 * the wrong syllable would point at a character this row is not asking for — worse than not
 * pointing at all. When the counts disagree the reading is printed exactly as it was before
 * this existed.
 */
function reading(example: Example, char: string): string {
  const chars = [...example.term];
  const syllables = example.syllables;
  if (syllables === undefined || syllables.length !== chars.length) {
    return escape(example.pinyin);
  }
  return chars
    .map((c, i) => (c === char ? `<b>${escape(syllables[i]!)}</b>` : escape(syllables[i]!)))
    .join('');
}

/**
 * Every cue on a sheet, disambiguated against each other.
 *
 * Blanking every answer on the sheet stops one row leaking another's answer, but two
 * answers drawn from the *same* example word then blank to the same string: 负 and 责 both
 * come from 负责, so both rows print `＿＿ fùzé — to be responsible for`. Identical cues
 * give no way to tell which row wants which character, and grading maps a row to the
 * character the manifest recorded for it — so writing the pair in the other order fails
 * both rows and feeds two false lapses into the schedule.
 *
 * Colliding rows fall back to the bare-character cue, whose pinyin distinguishes them
 * (fù against zé). That is a weaker cue than the word, and it is still the right trade:
 * an ambiguous cue does not merely lose information, it manufactures failures.
 *
 * A row whose cue was already decided keeps it. Those come from a manifest, meaning that
 * page has already been printed, and the printed page is the thing grading has to match.
 *
 * This is shared rather than inlined because the cue is both printed and written to the
 * manifest. Two implementations of "what does this row say" would eventually disagree,
 * and grading believes the manifest.
 */
export function buildCues(
  plans: readonly RecallPlan[],
  style: CueStyle,
  sheetAnswers: ReadonlySet<string>,
): string[] {
  const cues = plans.map((p) => p.cue ?? buildCue(p, style, sheetAnswers));

  const seen = new Map<string, number>();
  for (const cue of cues) seen.set(cue, (seen.get(cue) ?? 0) + 1);

  return cues.map((cue, i) => {
    if ((seen.get(cue) ?? 0) < 2) return cue;
    const plan = plans[i]!;
    if (plan.cue !== undefined) return plan.cue;
    // Dropping the example leaves `buildCue` with the character's own reading and gloss,
    // still blanked against every answer on the sheet.
    return buildCue({ ...plan, example: undefined }, style, sheetAnswers);
  });
}

/**
 * Recall inverts the drill sheet's derivation. There `rowsPerPage` is the knob and cell
 * size follows from it; here the cell is pinned to the drill cell size so both halves of
 * the sheet match, and the (shorter) recall row height determines how many fit instead.
 */
export function recallGeometry(config: SheetConfig, recall: RecallConfig): RecallGeometry {
  const m = computeMetrics(config);
  const usableHeightMm =
    config.pageHeightMm - config.marginTopMm - config.marginBottomMm - config.pageHeaderMm;

  // How many rows fit is decided by the TIGHTEST pitch a row can be printed at...
  const minPitchMm = recall.cueMm + m.cellMm + recall.gapMm;
  const rowsPerPage = Math.floor(usableHeightMm / minPitchMm);
  if (rowsPerPage < 1) {
    throw new Error(
      `A ${minPitchMm.toFixed(1)}mm recall row does not fit in ${usableHeightMm.toFixed(1)}mm ` +
        'of usable height.',
    );
  }

  // ...and then the leftover is spread back into the pitch, so the rows fill the page
  // instead of stacking at the top and leaving 15mm of dead paper above the bottom margin.
  // The margin itself is untouched — how much page there is to fill is layout.ts's call,
  // not this function's.
  const rowPitchMm = usableHeightMm / rowsPerPage;

  const originXMm = config.marginLeftMm;
  // Top of row 0's CELLS, below the cue line — see the module comment.
  const originYMm = config.marginTopMm + config.pageHeaderMm + recall.cueMm;

  return {
    cellMm: m.cellMm,
    originXMm,
    originYMm,
    rowPitchMm,
    cellsPerRow: recall.cellsPerRow,
    rowsPerPage,
    firstCellGapMm: recall.firstCellGapMm,
  };
}

/**
 * Millimetres for a style attribute, rounded.
 *
 * These numbers are divisions of the page and arrive with a float's full tail; a printed
 * position is not meaningful past a micron, and an untrimmed one makes the markup
 * unreadable when checking what a page actually says.
 */
const mm = (value: number): string => `${Number(value.toFixed(3))}mm`;

/** One cell is 100 units square, matching layout.ts's row coordinate space. */
const CELL_UNITS = 100;

/**
 * The row of empty cells as a single svg, exactly as `rowGrid` in layout.ts does it and for
 * the same reason: one svg per cell let sub-pixel rounding accumulate into visible seams
 * when printed. No model glyph here — recall cells start blank by definition.
 */
function recallGrid(columns: number, style: SheetConfig['gridStyle'], border = 2): string {
  const w = columns * CELL_UNITS;
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

  return (
    `<svg class="rc-grid" viewBox="0 0 ${w} ${CELL_UNITS}" preserveAspectRatio="none">` +
    `<path d="${inner.join(' ')}" stroke="#d5d5d5" stroke-width="0.8" stroke-dasharray="4 4" fill="none"/>` +
    `<path d="${dividers.join(' ')}" stroke="#8f8f8f" stroke-width="1" fill="none"/>` +
    `<rect x="${half}" y="${half}" width="${w - border}" height="${CELL_UNITS - border}" ` +
    `fill="none" stroke="#8f8f8f" stroke-width="${border}"/>` +
    `</svg>`
  );
}

// CRITICAL: 8 of the 9 distinct hanzi across these two strings (写 字 回 第 一 格 只 次) sit
// in the 1,200-character handwriting list, so any one of them can itself come due for
// recall. buildCue already blanks the cue for that row — but the header sits 12mm above it
// on the same page, and printing the bare answer there hands it over just as surely.
// renderRecallPages runs both strings through the same blankAll(sheetAnswers) the cues use,
// so a day one of these chars is due the header reads e.g. "第＿格只写＿次" instead. Do NOT
// "fix" this by deleting the Chinese text — the English half only carries the meaning
// because the Chinese half is there to blank.
const HEADER_TITLE = '写字回忆';
const PROTOCOL = '第一格只写一次 · first cell: one attempt, leave mistakes standing';

/**
 * The page header, generated once for two different selectors.
 *
 * The recall page and the answers page must look identical along the top — Franco flips
 * between them — but they are separate stylesheets and a shared selector would be exactly
 * the collision this whole split exists to prevent. So the rule is written once here and
 * stamped under each page's own prefixed class instead.
 */
function headStyles(selector: string, config: SheetConfig): string {
  return `${selector} {
  position: absolute;
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 2.8mm; line-height: ${config.pageHeaderMm}mm; color: #666;
  border-bottom: 0.2mm solid #ddd; overflow: hidden; white-space: nowrap;
}`;
}

/**
 * Cue and cells are positioned in absolute mm, not flowed with padding like the drill
 * sheet's rows. The manifest stores `recallGeometry`'s output and later maps graded ink
 * back onto it; flow layout (margins, collapsing whitespace) would make that mapping only
 * approximately true, which is worse than useless for something meant to be graded.
 */
function recallRow(
  plan: RecallPlan,
  indexOnPage: number,
  config: SheetConfig,
  recall: RecallConfig,
  g: RecallGeometry,
  cue: string,
): string {
  const cellsTopMm = rowCellsTopMm(g, indexOnPage);
  // Derived from the cells rather than from the margins, so a row printed against a stored
  // geometry keeps its cue attached to its own cells whatever pitch that geometry used.
  const cueTopMm = cellsTopMm - recall.cueMm;
  const gapMm = g.firstCellGapMm ?? 0;
  const restLeftMm = g.originXMm + g.cellMm + gapMm;
  const restColumns = g.cellsPerRow - 1;

  return (
    `<div class="rc-cue" style="left:${mm(g.originXMm)};top:${mm(cueTopMm)};` +
    `width:${mm(g.cellsPerRow * g.cellMm + gapMm)};height:${mm(recall.cueMm)};` +
    `line-height:${mm(recall.cueMm)};">${cue}</div>` +
    // Its own svg, and a heavier frame: this is the one attempt, and it is graded. The
    // separation is the whole point, so there is no seam here to worry about.
    `<div class="rc-first" style="left:${mm(g.originXMm)};top:${mm(cellsTopMm)};` +
    `width:${mm(g.cellMm)};height:${mm(g.cellMm)};">` +
    `${recallGrid(1, config.gridStyle, FIRST_CELL_BORDER)}</div>` +
    // The rest stay ONE svg. Per-cell svgs accumulated sub-pixel rounding into seams that
    // printed as a row split into blocks. A row with no cells after the first draws
    // nothing at all here — a zero-column grid is malformed, not empty.
    (restColumns < 1
      ? ''
      : `<div class="rc-cells" style="left:${mm(restLeftMm)};top:${mm(cellsTopMm)};` +
        `width:${mm(restColumns * g.cellMm)};height:${mm(g.cellMm)};">` +
        `${recallGrid(restColumns, config.gridStyle)}</div>`)
  );
}

/** Twice the ordinary cell border — 0.5mm at the default cell, plainly heavier in print. */
const FIRST_CELL_BORDER = 4;

/** Top of a row's cell band, in page millimetres. */
const rowCellsTopMm = (g: RecallGeometry, indexOnPage: number): number =>
  g.originYMm + indexOnPage * g.rowPitchMm;

/**
 * Every recall class is prefixed `rc-`. The unprefixed generic names (`.page-head`,
 * `.row`, `.cells`) belong to layout.ts, and both stylesheets land in one document — a
 * shared name there is not a clash the browser reports, it is a silent merge. That is
 * exactly how recall's absolutely-positioned header ended up moving the drill page's.
 */
export function recallStyles(config: SheetConfig): string {
  return `
${headStyles('.rc-head', config)}
.rc-cue {
  position: absolute;
  font-size: 2.8mm; color: #333; overflow: hidden; white-space: nowrap;
}
.rc-cue i { color: #777; font-style: normal; }
/* The reading is set grey; weight alone inside grey is a weak mark on e-ink, and this is
   the mark that says WHICH character the row wants. Darkened as well as emboldened. */
.rc-cue i b { color: #222; font-weight: 700; }
.rc-first { position: absolute; }
.rc-cells { position: absolute; }
.rc-grid { display: block; width: 100%; height: 100%; }
`.trim();
}

/**
 * How the rows divide into pages. Recall and answers must agree on this exactly — the link
 * between a cue and its answer is position, so answer n has to land where row n's first
 * cell was — which is why both fragments derive their pages from this one function.
 */
function paginate(plans: readonly RecallPlan[], g: RecallGeometry): RecallPlan[][] {
  const pages: RecallPlan[][] = [];
  for (let i = 0; i < plans.length; i += g.rowsPerPage) {
    pages.push(plans.slice(i, i + g.rowsPerPage));
  }
  return pages;
}

/**
 * The recall pages, one string per page.
 *
 * Kept separate from `recallFragment` because the sheet interleaves each recall page with
 * its own answers page — see render/sheet.ts. Concatenating them is what `recallFragment`
 * is for.
 */
export function recallPages(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string[] {
  if (plans.length === 0) return [];

  const g = geometry ?? recallGeometry(config, recall);
  const pages = paginate(plans, g);

  // One set for the whole sheet, not one per page: a row must not leak another row's
  // answer even when that row landed on a different page, and building it once here
  // (rather than per page) stays correct if `recall.pages` is ever raised above 1.
  const sheetAnswers = new Set(plans.map((p) => p.char));
  // Across the whole sheet, not per page, for the same reason `sheetAnswers` is: two rows
  // that collide must be told apart even when they land on different pages.
  const cues = buildCues(plans, recall.cueStyle, sheetAnswers);

  return pages.map((page, pi) => {
    const rows = page
      .map((p, ri) => recallRow(p, ri, config, recall, g, cues[pi * g.rowsPerPage + ri]!))
      .join('');
    return `<div class="page rc-page">${recallHead(meta, sheetAnswers, config, pi, pages.length)}${rows}</div>`;
  });
}

/** Just the recall pages, or '' when nothing is due. See document.ts for why. */
export function recallFragment(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string {
  return recallPages(plans, meta, config, recall, geometry).join('');
}

/**
 * Blanked the same way the cues are: the header sits right above the cells it labels, so
 * an unblanked header would hand over the answer to whichever row it happens to sit near.
 */
function recallHead(
  meta: { date: string },
  sheetAnswers: ReadonlySet<string>,
  config: SheetConfig,
  pageIndex: number,
  pageCount: number,
): string {
  const headerTitle = blankAll(HEADER_TITLE, sheetAnswers);
  const protocol = blankAll(PROTOCOL, sheetAnswers);
  return (
    `<div class="rc-head" style="${headBox(config)}">` +
    `<span>${escape(headerTitle)} · ${escape(meta.date)}</span>` +
    `<span>${escape(protocol)}</span>` +
    `<span>${pageIndex + 1}/${pageCount}</span></div>`
  );
}

/** The header's box, in the absolute-mm terms both header kinds are positioned with. */
function headBox(config: SheetConfig): string {
  return (
    `left:${config.marginLeftMm}mm;top:${config.marginTopMm}mm;` +
    `width:${config.pageWidthMm - config.marginLeftMm - config.marginRightMm}mm;` +
    `height:${config.pageHeaderMm}mm;`
  );
}

/** The recall pages as a standalone document. Empty input renders nothing at all. */
export function renderRecallPages(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string {
  if (plans.length === 0) return '';
  // The title is blanked for the same reason the header is: it is text on the same
  // document as the cells it would give away.
  const title = blankAll(HEADER_TITLE, new Set(plans.map((p) => p.char)));
  return composeDocument({
    title: `${title} ${meta.date}`,
    styles: [frameStyles(config), recallStyles(config)],
    body: recallFragment(plans, meta, config, recall, geometry),
  });
}

// The answers page shows the answers on purpose, so — unlike the recall header — this one
// is NOT run through blankAll. It is still worth keeping small, grey and inside the header
// band: the answers themselves are cell-sized glyphs in a column down the left, so header
// text can never be mistaken for one. 答案 leads, and is emboldened, so the page announces
// itself at a glance rather than having to be read.
const SOLUTIONS_TITLE = '写字回忆';
const SOLUTIONS_LABEL = '答案';
const SOLUTIONS_NOTE = '对答案 · answers — check after the first cell, then fill the row';

/**
 * How the answer row divides vertically: the reading takes this much off the top, and the
 * stroke-order filmstrip gets the rest of the cell's height.
 *
 * 4.4mm is the drill row's own header height, so the two pages set their reading lines at
 * the same size. Leaving the strip the remainder rather than a fixed height is what lets it
 * shrink gracefully under a stored geometry with a smaller cell.
 */
const SOLUTION_READING_MM = 4.4;

/** Between filmstrip frames. Matches the drill row's gap so the two strips read alike. */
const SOLUTION_FRAME_GAP_MM = 0.3;

/**
 * Frames are budgeted for this many even when a character has fewer, so every strip on the
 * page is drawn at one size — a row of ragged frame sizes reads as a rendering fault. 20 is
 * the drill row's own cap; nothing in the handwriting list needs more.
 */
const SOLUTION_MAX_FRAMES = 20;

/** The answers page's own rules; `sol-` prefixed for the same reason recall's are. */
export function solutionStyles(config: SheetConfig): string {
  return `
${headStyles('.sol-head', config)}
.sol-head b { font-weight: 600; color: #333; }
.sol-glyph { position: absolute; }
.sol-glyph svg { display: block; width: 100%; height: 100%; }
.sol-meta {
  position: absolute;
  font-size: 3mm; color: #333; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.sol-meta i { color: #777; font-style: normal; }
/* The frames carry their own mm width and height, so this only has to line them up. */
.sol-strip {
  position: absolute;
  display: flex; align-items: center; gap: ${SOLUTION_FRAME_GAP_MM}mm; overflow: hidden;
}
`.trim();
}

/**
 * How big one filmstrip frame may be drawn, in mm.
 *
 * Bounded twice, so neither dimension can overflow: by the height left under the reading
 * line, and by the width a full budget of frames has to share. Floored to a micron rather
 * than rounded, because rounding the size up multiplies by the frame count and would push
 * the last frame past the right margin.
 */
function solutionFrameMm(bandMm: number, availableWidthMm: number): number {
  const byWidth =
    (availableWidthMm - (SOLUTION_MAX_FRAMES - 1) * SOLUTION_FRAME_GAP_MM) / SOLUTION_MAX_FRAMES;
  return Math.floor(Math.max(0, Math.min(bandMm, byWidth)) * 1000) / 1000;
}

/**
 * One answer: the character drawn at practice-cell size, with its reading and its
 * stroke-order filmstrip beside it.
 *
 * Drawn from the same stroke outlines as the drill sheet's model character, at the same
 * size, in the same 米字格-sized box — this is the page that says what the right form is,
 * so it must not be the one page set in whatever system font happens to be installed.
 *
 * The filmstrip is there because of when this page gets read: Franco turns to it having
 * just failed to write the character from memory, and at that moment the useful answer is
 * how to write it, not only what it was. It is the same `strokeFilmstrip` the drill rows
 * use, drawn larger — the drill squeezes it into 3.8mm of row header, whereas here the
 * whole width beside the glyph is free.
 */
function solutionRow(plan: RecallPlan, indexOnPage: number, config: SheetConfig, g: RecallGeometry): string {
  const topMm = rowCellsTopMm(g, indexOnPage);
  const gapMm = g.firstCellGapMm ?? 0;
  const metaLeftMm = g.originXMm + g.cellMm + gapMm;
  const metaWidthMm = config.pageWidthMm - config.marginRightMm - metaLeftMm;

  const glyph = loadGlyph(plan.char);
  const drawing =
    glyph !== null
      ? `<svg x="0" y="0" width="${CELL_UNITS}" height="${CELL_UNITS}" viewBox="${MODEL_VIEWBOX}">` +
        `<g transform="${GLYPH_TRANSFORM}">${glyphPaths(glyph, { fill: '#000' })}</g></svg>`
      : `<text x="${CELL_UNITS / 2}" y="${CELL_UNITS * 0.78}" font-size="${CELL_UNITS * 0.8}" ` +
        `text-anchor="middle" fill="#000">${escape(plan.char)}</text>`;

  const meta = [plan.pinyin, plan.meaning].filter((t) => t !== '').map(escape).join(' — ');
  const example =
    plan.example === undefined
      ? ''
      : ` · ${escape(plan.example.term)} <i>${escape(plan.example.pinyin)}</i>`;

  // The reading takes the top of the row and the strip takes what is left, so the two never
  // compete for the same millimetres however small the cell a stored geometry hands over.
  const bandMm = Math.max(0, g.cellMm - SOLUTION_READING_MM);
  const frameMm = solutionFrameMm(bandMm, metaWidthMm);
  const strip =
    glyph === null || frameMm <= 0
      ? ''
      : `<div class="sol-strip" style="left:${mm(metaLeftMm)};top:${mm(topMm + SOLUTION_READING_MM)};` +
        `width:${mm(metaWidthMm)};height:${mm(bandMm)};">` +
        `${strokeFilmstrip(glyph, { sizeMm: frameMm, maxFrames: SOLUTION_MAX_FRAMES })}</div>`;

  return (
    `<div class="sol-glyph" style="left:${mm(g.originXMm)};top:${mm(topMm)};` +
    `width:${mm(g.cellMm)};height:${mm(g.cellMm)};">` +
    // No cell outline. One user unit here is 0.125mm — about 1.5 device pixels — so a
    // hairline rect rasterised unevenly, solid on one edge and nearly absent on another,
    // which reads as a rendering fault rather than a guide. Thickening it would trade the
    // artefact for a heavy box around every answer; the answers already sit on exactly
    // the recall geometry, so position alone carries the alignment.
    `<svg viewBox="0 0 ${CELL_UNITS} ${CELL_UNITS}" preserveAspectRatio="none">` +
    `${drawing}</svg></div>` +
    `<div class="sol-meta" style="left:${mm(metaLeftMm)};top:${mm(topMm)};` +
    `width:${mm(metaWidthMm)};height:${mm(SOLUTION_READING_MM)};` +
    `line-height:${mm(SOLUTION_READING_MM)};">${meta}${example}</div>` +
    strip
  );
}

/**
 * The answers pages, one string per page.
 *
 * Paginated and positioned on exactly the recall geometry, so answer n sits where row n's
 * first cell was on the page in front of it. The link between a cue and its answer used to
 * be a printed row number; now it is the position itself, which is what Franco actually
 * uses when he flips back and forth — and why the sheet puts each answers page immediately
 * after the recall page it answers rather than stacking them all at the end.
 */
export function solutionPages(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string[] {
  if (plans.length === 0) return [];

  const g = geometry ?? recallGeometry(config, recall);
  const pages = paginate(plans, g);

  // The title is blanked here too, even though this page exists to show answers. Its ROWS
  // may show them; its header must not, because the answers pages are now interleaved —
  // answers page 1 sits between recall page 1 and recall page 2, so an unblanked title
  // hands over any answer that appears on a later recall page. 回 is in 写字回忆 and is a
  // handwriting character, so this is reachable, not theoretical.
  const sheetAnswers = new Set(plans.map((p) => p.char));
  const label = blankAll(SOLUTIONS_LABEL, sheetAnswers);
  const title = blankAll(SOLUTIONS_TITLE, sheetAnswers);
  const note = blankAll(SOLUTIONS_NOTE, sheetAnswers);

  return pages.map((page, pi) => {
    const head =
      `<div class="sol-head" style="${headBox(config)}">` +
      `<span><b>${escape(label)}</b> · ${escape(title)} · ${escape(meta.date)}</span>` +
      `<span>${escape(note)}</span>` +
      `<span>${pi + 1}/${pages.length}</span></div>`;
    const rows = page.map((p, ri) => solutionRow(p, ri, config, g)).join('');
    return `<div class="page sol-page">${head}${rows}</div>`;
  });
}

/** Every answers page concatenated, or '' when there is nothing to answer. */
export function solutionsFragment(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string {
  return solutionPages(plans, meta, config, recall, geometry).join('');
}

/** The answers page as a standalone document. Empty input renders nothing at all. */
export function renderSolutionsPage(
  plans: readonly RecallPlan[],
  meta: { date: string },
  config: SheetConfig,
  recall: RecallConfig,
  geometry?: RecallGeometry,
): string {
  if (plans.length === 0) return '';
  return composeDocument({
    title: `答案 ${meta.date}`,
    styles: [frameStyles(config), solutionStyles(config)],
    body: solutionsFragment(plans, meta, config, recall, geometry),
  });
}
