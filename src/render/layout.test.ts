import { describe, it, expect } from 'vitest';
import { renderSheet, computeMetrics, DEFAULT_SHEET_CONFIG } from './layout.js';
import type { CharacterPlan } from '../select/enrich.js';
import { DEFAULT_COUNT } from '../generate.js';

const plan = (char: string, over: Partial<CharacterPlan> = {}): CharacterPlan => ({
  char,
  pinyin: 'guàn',
  meaning: 'accustomed to',
  strokeCount: 11,
  reason: 'linear',
  example: { term: '习惯', pinyin: 'xíguàn', meaning: 'habit' },
  ...over,
});

const chars = (n: number) => '惯父校爱是在有我他这们来为和'.slice(0, n).split('').map((c) => plan(c));
const count = (h: string, needle: string) => h.split(needle).length - 1;

describe('computeMetrics', () => {
  it('derives bigger cells from fewer rows', () => {
    const eight = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 8 });
    const six = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 6 });
    expect(six.cellMm).toBeGreaterThan(eight.cellMm);
  });

  // Bigger cells mean fewer fit across the page — both follow from one setting.
  it('derives cells-per-row from cell size, not configuration', () => {
    const eight = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 8 });
    const six = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 6 });
    expect(six.repetitions).toBeLessThan(eight.repetitions);
  });

  it('leaves breathing space at the end of every row', () => {
    for (const rowsPerPage of [5, 6, 7, 8, 9]) {
      const m = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage });
      const used = m.repetitions * m.cellMm;
      expect(used).toBeLessThanOrEqual(m.usableWidthMm - DEFAULT_SHEET_CONFIG.rowEndSpaceMm);
    }
  });

  it('keeps the rows strictly inside the page so none can clip', () => {
    for (const rowsPerPage of [5, 6, 7, 8, 9]) {
      const m = computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage });
      expect(m.blockHeightMm * rowsPerPage).toBeLessThan(m.usableHeightMm);
    }
  });

  it('gives the left edge more clearance than the right, for the toolbar', () => {
    expect(DEFAULT_SHEET_CONFIG.marginLeftMm).toBeGreaterThan(DEFAULT_SHEET_CONFIG.marginRightMm);
  });

  // The bottom margin was 18mm to clear the Supernote's page-navigation strip. Franco has
  // hidden that strip, so the space is reclaimed and the bottom is now an ordinary page
  // margin, in the same range as the right one rather than three times it.
  it('keeps an ordinary bottom margin, not device-furniture clearance', () => {
    expect(DEFAULT_SHEET_CONFIG.marginBottomMm).toBe(8);
    expect(DEFAULT_SHEET_CONFIG.marginBottomMm)
      .toBeLessThan(2 * DEFAULT_SHEET_CONFIG.marginRightMm);
  });

  // The point of reclaiming it: every derived dimension gets the space, and none of them
  // is pinned by hand.
  it('spends the reclaimed height on taller cells, derived not pinned', () => {
    const reclaimed = computeMetrics(DEFAULT_SHEET_CONFIG);
    const withNavBar = computeMetrics({ ...DEFAULT_SHEET_CONFIG, marginBottomMm: 18 });
    expect(reclaimed.cellMm).toBeGreaterThan(withNavBar.cellMm);
    expect(reclaimed.blockHeightMm).toBeGreaterThan(withNavBar.blockHeightMm);
  });

  it('produces a comfortable cell at the default setting', () => {
    const m = computeMetrics(DEFAULT_SHEET_CONFIG);
    expect(m.cellMm).toBeGreaterThan(11);
    expect(m.repetitions).toBeGreaterThanOrEqual(8);
  });

  it('refuses a configuration that cannot produce a legible cell', () => {
    expect(() => computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 60 })).toThrow(/rowsPerPage/);
    expect(() => computeMetrics({ ...DEFAULT_SHEET_CONFIG, rowsPerPage: 14 })).toThrow(/6mm minimum/);
  });
});

describe('renderSheet', () => {
  const html = renderSheet(chars(3), { date: '2026-08-19', mode: 'linear' });

  it('renders one row per character', () => {
    expect(count(html, 'class="row"')).toBe(3);
  });

  // One svg per cell let rounding accumulate into visible seams that split the row into
  // blocks of 6 + 4 + 4. One svg per row makes that impossible.
  it('draws each row of cells as a single continuous grid', () => {
    expect(count(html, 'class="grid"')).toBe(3);
    expect(html).not.toContain('class="cell"');
  });

  it('shows the model character once, with no fade across later cells', () => {
    const row = html.split('class="row"')[1]!;
    // The model is the only nested glyph svg placed inside the grid's first cell.
    expect(count(row, 'x="0" y="0" width="100" height="100"')).toBe(1);
    // Fading is gone entirely, so nothing in the grid is drawn at partial opacity.
    const grid = row.split('class="grid"')[1] ?? '';
    expect(grid).not.toContain('opacity');
  });

  it('shows pinyin and meaning but not the stroke count', () => {
    expect(html).toContain('guàn');
    expect(html).toContain('accustomed to');
    expect(html).not.toContain('画');
  });

  it('shows the example term with its own pinyin and meaning', () => {
    expect(html).toContain('习惯');
    expect(html).toContain('xíguàn');
    expect(html).toContain('habit');
  });

  it('includes a stroke-order filmstrip', () => {
    expect(html).toContain('class="filmstrip"');
  });

  it('sets an exact print page size in millimetres', () => {
    expect(html).toContain('@page');
    expect(html).toContain('162.6mm');
    expect(html).toContain('216.7mm');
  });

  it('applies the uneven margins as page padding', () => {
    const c = DEFAULT_SHEET_CONFIG;
    expect(html).toContain(
      `padding: ${c.marginTopMm}mm ${c.marginRightMm}mm ${c.marginBottomMm}mm ${c.marginLeftMm}mm`,
    );
  });

  it('paginates at the configured rows per page', () => {
    const two = renderSheet(chars(14), { date: '2026-08-19', mode: 'linear' });
    expect(count(two, 'class="page ')).toBe(2);
  });

  // The daily count is one page's worth of rows, so an ordinary day prints exactly one
  // drill page and never a near-empty second one.
  it('fills one page exactly at the daily character count', () => {
    const full = renderSheet(
      Array.from({ length: DEFAULT_COUNT }, () => plan('惯')),
      { date: '2026-08-19', mode: 'linear' },
    );
    expect(DEFAULT_COUNT).toBe(DEFAULT_SHEET_CONFIG.rowsPerPage);
    expect(count(full, 'class="page ')).toBe(1);
    expect(count(full, 'class="row"')).toBe(DEFAULT_COUNT);
  });

  it('escapes text so a stray angle bracket cannot break the page', () => {
    const html2 = renderSheet([plan('惯', { meaning: 'a <b>bold</b> claim' })], {
      date: '2026-08-19',
      mode: 'linear',
    });
    expect(html2).toContain('&lt;b&gt;');
  });
});

describe('renderSheet — characters without stroke data', () => {
  const noStrokes: CharacterPlan = {
    char: '𰻞',
    pinyin: 'biáng',
    meaning: 'a noodle',
    strokeCount: 0,
    reason: 'linear',
  };
  const html = renderSheet([noStrokes], { date: '2026-08-19', mode: 'linear' });

  it('still shows the character in the model cell', () => {
    expect(html).toContain('𰻞');
  });

  it('omits the filmstrip rather than faking one', () => {
    expect(html).not.toContain('class="filmstrip"');
  });

  it('says plainly that stroke data is missing', () => {
    expect(html).toMatch(/no stroke data/i);
  });
});

describe('renderSheet — model glyph fit', () => {
  it('insets the model glyph so it does not touch the cell walls', () => {
    const html = renderSheet([plan('惯')], { date: '2026-08-19', mode: 'linear' });
    const model = /viewBox="(-[\d.]+) (-[\d.]+) ([\d.]+) ([\d.]+)"/.exec(html);
    expect(model).not.toBeNull();
    // A viewBox wider than the 1024 glyph box shrinks the drawing inside the cell.
    expect(Number(model![3])).toBeGreaterThan(1024);
  });
});

describe('renderSheet — text must not clip', () => {
  const html = renderSheet([plan('惯')], { date: '2026-08-19', mode: 'linear' });

  // The example line was being cut in half: a 2.9mm font in a 3mm box with overflow
  // hidden. Pinning line-height to the box height keeps the text inside it.
  it('pins each text line-height to its box height', () => {
    expect(html).toContain(`line-height: ${DEFAULT_SHEET_CONFIG.exampleMm}mm`);
    expect(html).toContain(`line-height: ${DEFAULT_SHEET_CONFIG.headerMm}mm`);
  });

  it('keeps every font smaller than the box that holds it', () => {
    const foot = /\.row-foot \{[^}]*font-size: ([\d.]+)mm/.exec(html);
    expect(Number(foot![1])).toBeLessThan(DEFAULT_SHEET_CONFIG.exampleMm);
  });
});

describe('renderSheet — grid borders must not clip', () => {
  const html = renderSheet([plan('惯')], { date: '2026-08-19', mode: 'linear' });

  // A stroke centred on x=0 loses its outer half to the viewBox edge, which showed up as a
  // missing left border on every row and missing bottom borders where rounding landed.
  it('insets the outer frame by half its stroke width', () => {
    const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*stroke-width="([\d.]+)"/.exec(html);
    expect(rect).not.toBeNull();
    const [, x, y, , height, strokeWidth] = rect!.map(Number) as unknown as number[];
    expect(x).toBeCloseTo(strokeWidth! / 2, 5);
    expect(y).toBeCloseTo(strokeWidth! / 2, 5);
    expect(height! + strokeWidth!).toBeCloseTo(100, 5);
  });

  it('keeps the frame strictly inside the viewBox', () => {
    const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*stroke-width="([\d.]+)"/.exec(html)!;
    const [, x, y, width, height, sw] = rect.map(Number) as unknown as number[];
    expect(x! - sw! / 2).toBeGreaterThanOrEqual(0);
    expect(y! - sw! / 2).toBeGreaterThanOrEqual(0);
    expect(y! + height! + sw! / 2).toBeLessThanOrEqual(100);
    expect(width!).toBeGreaterThan(0);
  });
});
