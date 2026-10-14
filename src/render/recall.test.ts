import { describe, it, expect } from 'vitest';
import { buildCue, buildCues, recallGeometry, recallStyles, renderRecallPages, renderSolutionsPage,
         DEFAULT_RECALL_CONFIG, type RecallPlan } from './recall.js';
import { DEFAULT_SHEET_CONFIG, computeMetrics } from './layout.js';
import { loadGlyph, glyphPaths } from './glyph.js';
import type { RecallGeometry } from '../state/sheets.js';

const CFG = DEFAULT_SHEET_CONFIG;
const RC = DEFAULT_RECALL_CONFIG;
const PRINTABLE_BOTTOM_MM = CFG.pageHeightMm - CFG.marginBottomMm;

/** Every `top:` in mm from the divs matching a class, in document order. */
const topsOf = (html: string, cls: string): number[] =>
  [...html.matchAll(new RegExp(`class="${cls}" style="[^"]*top:([\\d.]+)mm`, 'g'))].map((m) => Number(m[1]));

/** Positions land in the markup rounded, so compare them as numbers, not as strings. */
const expectMm = (got: number[], want: number[]): void => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 2));
};

/** Every `left:` in mm from the divs matching a class, in document order. */
const leftsOf = (html: string, cls: string): number[] =>
  [...html.matchAll(new RegExp(`class="${cls}" style="left:([\\d.]+)mm`, 'g'))].map((m) => Number(m[1]));

const plan = (over: Partial<RecallPlan> = {}): RecallPlan => ({
  char: '市', pinyin: 'shì', meaning: 'city; market',
  example: { term: '城市', pinyin: 'chéngshì', meaning: 'city' }, ...over,
});

describe('buildCue', () => {
  it('blanks the target inside its example word', () => {
    expect(buildCue(plan(), 'gap')).toContain('城＿');
  });

  it('blanks the target wherever it sits in the word', () => {
    expect(buildCue(plan({ char: '城', example: { term: '城市', pinyin: 'chéngshì', meaning: 'city' } }), 'gap'))
      .toContain('＿市');
  });

  it('blanks every occurrence when the character repeats', () => {
    expect(buildCue(plan({ char: '天', example: { term: '天天', pinyin: 'tiāntiān', meaning: 'every day' } }), 'gap'))
      .toContain('＿＿');
  });

  it('cues with the whole word pinyin and meaning, never the bare character', () => {
    const cue = buildCue(plan(), 'gap');
    expect(cue).toContain('chéngshì');
    expect(cue).not.toContain('shì ·');
  });

  it('falls back to the bare character when there is no example word', () => {
    const cue = buildCue(plan({ example: undefined }), 'gap');
    expect(cue).toContain('shì');
    expect(cue).toContain('city');
    expect(cue).not.toContain('＿');
  });

  it('ignores the example entirely in plain style', () => {
    const cue = buildCue(plan(), 'plain');
    expect(cue).not.toContain('城');
    expect(cue).toContain('shì');
  });

  it('never leaks the answer in either style', () => {
    for (const style of ['gap', 'plain'] as const) {
      expect(buildCue(plan(), style)).not.toContain('市');
    }
  });

  it('escapes markup in a gloss', () => {
    // The cue emits its own <b> around the target's syllable, so "contains no <b>" would no
    // longer be the question. What matters is that the gloss's own angle brackets arrive as
    // text: a gloss that could open a tag could also close the cue's.
    const cue = buildCue(plan({ meaning: 'a <b> thing', example: undefined }), 'plain');
    expect(cue).toContain('a &lt;b&gt; thing');
    expect(cue).not.toContain('a <b> thing');
  });

  // Real leak found by scanning all 1,200 handwriting characters through buildCue: the
  // example word's own gloss ("variant of 公布") names the target character in prose, not
  // just in the word itself. Blanking example.term is not enough — the meaning has to be
  // blanked too.
  it('blanks the target when it appears inside the example word\'s meaning', () => {
    const cue = buildCue(
      plan({
        char: '布',
        pinyin: 'bù',
        meaning: 'cloth; to declare',
        example: { term: '公布', pinyin: 'gōngbù', meaning: 'variant of 公布' },
      }),
      'gap',
    );
    expect(cue).not.toContain('布');
  });

  // Real leak: with no example, the character's own gloss ("see 咱") can name the
  // character it is glossing.
  it('blanks the target when it appears inside the bare character\'s own meaning', () => {
    const cue = buildCue(plan({ char: '咱', pinyin: 'zá / zán', meaning: 'see 咱', example: undefined }), 'plain');
    expect(cue).not.toContain('咱');
  });

  // A handful of real plans pulled from the leak scan (dictionary glosses that happen to
  // name their own headword or the example word's headword). Each must come back clean in
  // both cue styles, not just the ones each leaked in originally.
  const leakingPlans: RecallPlan[] = [
    { char: '布', pinyin: 'bù', meaning: 'cloth; to declare',
      example: { term: '公布', pinyin: 'gōngbù', meaning: 'variant of 公布' } },
    { char: '宣', pinyin: 'xuān', meaning: 'to declare; to announce',
      example: { term: '宣布', pinyin: 'xuānbù', meaning: 'variant of 宣布' } },
    { char: '警', pinyin: 'jǐng', meaning: 'police; to warn',
      example: { term: '交警', pinyin: 'jiāojǐng', meaning: 'traffic police (abbr. for 交通警察)' } },
    { char: '咱', pinyin: 'zá / zán', meaning: 'see 咱' },
    { char: '美', pinyin: 'Měi / měi', meaning: '(bound form) the Americas (abbr. for 美洲)' },
  ];

  it('never leaks the answer for any known-leaking plan, in either style', () => {
    for (const p of leakingPlans) {
      for (const style of ['gap', 'plain'] as const) {
        expect(buildCue(p, style)).not.toContain(p.char);
      }
    }
  });

  // Real cross-row leak found by inspecting a generated sheet (2026-09-01): 他们/你们/我们
  // all contain 们, so a sheet that recalls both 他 and 们 the same day prints 们 in the
  // row asking for 他 — the row's own target was correctly blanked, but a *different* row's
  // answer wasn't. Characters due the same day come from the same drill sheet, so their HSK
  // example words collide on pronouns and measure words constantly; this is structural, not
  // rare. sheetAnswers is how buildCue is told about every other answer on the page.
  const ta = plan({
    char: '他', pinyin: 'tā', meaning: 'he; him',
    example: { term: '他们', pinyin: 'tāmen', meaning: 'they' },
  });
  const men = plan({
    char: '们', pinyin: 'men', meaning: 'plural marker for pronouns',
    example: { term: '你们', pinyin: 'nǐmen', meaning: 'you (plural)' },
  });
  const sheet = new Set([ta.char, men.char]);

  it('blanks another row\'s answer when it shows up in this row\'s cue', () => {
    // 他's own example word 他们 contains 们 — that is a DIFFERENT row's answer, not 他's
    // own, and 他's cue must not hand it over.
    const cue = buildCue(ta, 'gap', sheet);
    expect(cue).not.toContain('他');
    expect(cue).not.toContain('们');
  });

  it('blanks the target row\'s own answer even when a different plan supplied the set', () => {
    // 们's own cue must obviously still blank 们 itself, and also not print 他 — proving the
    // whole set is consulted per row, not just each row's own character.
    const cue = buildCue(men, 'gap', sheet);
    expect(cue).not.toContain('他');
    expect(cue).not.toContain('们');
  });

  it('consults every answer in the set, not only the row\'s own character', () => {
    // 布's own cue leaks nothing on its own (its term/meaning never mention 们), so this
    // specifically proves sheetAnswers's OTHER entries are checked, not just plan.char.
    const bu = plan({
      char: '布', pinyin: 'bù', meaning: 'cloth; to declare',
      example: { term: '公布', pinyin: 'gōngbù', meaning: 'to announce publicly' },
    });
    const cue = buildCue(bu, 'gap', new Set(['布', '公']));
    expect(cue).not.toContain('公');
  });

  it('behaves exactly as before when called without a sheetAnswers set', () => {
    // The third parameter is optional: a direct call with only (plan, style) — as every
    // test above this one does — must still only blank the row's own character.
    expect(buildCue(plan(), 'gap')).toBe(buildCue(plan(), 'gap', undefined));
    expect(buildCue(plan(), 'gap')).toContain('城＿');
  });
});

describe('buildCues — two answers from one word', () => {
  // 负 and 责 both come from 负责. Blanking every answer on the sheet turns both rows into
  // "＿＿ fùzé", which gives no way to tell which row wants which character — and grading
  // maps a row to the character the manifest recorded, so the wrong order fails both.
  const fuze = { term: '负责', pinyin: 'fùzé', meaning: 'to be responsible for' };
  const pair = [
    { char: '负', pinyin: 'fù', meaning: 'to bear', example: fuze },
    { char: '责', pinyin: 'zé', meaning: 'duty', example: fuze },
  ];
  const answers = new Set(['负', '责']);

  it('never gives two rows the same cue', () => {
    const cues = buildCues(pair, 'gap', answers);
    expect(cues[0]).not.toBe(cues[1]);
  });

  it('still leaks neither answer', () => {
    for (const cue of buildCues(pair, 'gap', answers)) {
      expect(cue).not.toContain('负');
      expect(cue).not.toContain('责');
    }
  });

  it('distinguishes them by their own readings', () => {
    const cues = buildCues(pair, 'gap', answers);
    expect(cues[0]).toContain('fù');
    expect(cues[1]).toContain('zé');
  });

  it('leaves non-colliding rows on their word cue', () => {
    const mixed = [...pair, { char: '城', pinyin: 'chéng', meaning: 'city walls',
      example: { term: '城市', pinyin: 'chéngshì', meaning: 'city' } }];
    const cues = buildCues(mixed, 'gap', new Set(['负', '责', '城']));
    expect(cues[2]).toContain('chéngshì');
  });

  it('keeps a cue a manifest already decided, collision or not', () => {
    const reused = pair.map((p) => ({ ...p, cue: 'FROM MANIFEST' }));
    expect(buildCues(reused, 'gap', answers)).toEqual(['FROM MANIFEST', 'FROM MANIFEST']);
  });
});

describe('recallGeometry', () => {
  it('uses the same cell size as the drill rows', () => {
    const g = recallGeometry(DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(g.cellMm).toBeCloseTo(computeMetrics(DEFAULT_SHEET_CONFIG).cellMm, 5);
  });

  it('fits more recall rows per page than drill rows, being shorter', () => {
    const g = recallGeometry(DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(g.rowsPerPage).toBeGreaterThan(DEFAULT_SHEET_CONFIG.rowsPerPage);
  });

  // Measured to the bottom of the last row's CELL BAND, not the bottom of its pitch: the
  // tail of a pitch is the next row's cue space, and no row follows the last one.
  it('keeps the last row\'s cells inside the printable area', () => {
    const g = recallGeometry(CFG, RC);
    const lastCellBottom = g.originYMm + (g.rowsPerPage - 1) * g.rowPitchMm + g.cellMm;
    expect(lastCellBottom).toBeLessThanOrEqual(PRINTABLE_BOTTOM_MM + 0.001);
  });

  // The rows used 172mm of 187.7mm and left 15.7mm of dead paper above the navigation bar,
  // because the pitch stayed at the minimum that determined the row COUNT.
  it('spreads the leftover height into the pitch instead of leaving it at the bottom', () => {
    const g = recallGeometry(CFG, RC);
    const lastCellBottom = g.originYMm + (g.rowsPerPage - 1) * g.rowPitchMm + g.cellMm;
    expect(PRINTABLE_BOTTOM_MM - lastCellBottom).toBeLessThan(2);
  });

  it('still derives the row count from the minimum pitch', () => {
    const g = recallGeometry(CFG, RC);
    const usableHeightMm = CFG.pageHeightMm - CFG.marginTopMm - CFG.marginBottomMm - CFG.pageHeaderMm;
    const minPitch = RC.cueMm + computeMetrics(CFG).cellMm + RC.gapMm;
    expect(g.rowsPerPage).toBe(Math.floor(usableHeightMm / minPitch));
    expect(g.rowPitchMm).toBeGreaterThan(minPitch);
  });

  // Filling the page comes out of the slack between rows, never out of the margin.
  it('leaves the bottom margin alone', () => {
    expect(CFG.marginBottomMm).toBe(8);
  });

  it('keeps every cell, and the first-cell gap, inside the printable width', () => {
    const g = recallGeometry(CFG, RC);
    const right = g.originXMm + g.cellsPerRow * g.cellMm + (g.firstCellGapMm ?? 0);
    expect(right).toBeLessThanOrEqual(CFG.pageWidthMm - CFG.marginRightMm + 0.001);
  });

  // Only cell 1 is graded — it is the one attempt, never erased — so it is set apart from
  // the cells that get written after checking the answers.
  it('separates the graded first cell from the rest', () => {
    expect(recallGeometry(CFG, RC).firstCellGapMm).toBeGreaterThan(0);
  });

  // Two pages, ~20 items a day, against an intake of 9 new characters a day. At one page
  // the queue grew by ~8 a day and a character's first recall test slipped to 3-5 days
  // after it was drilled; retention measured 75% at a 3-day lag, 42% at 4, 25% at 5.
  it('asks for two recall pages a day, so the backlog drains rather than grows', () => {
    expect(DEFAULT_RECALL_CONFIG.pages).toBe(2);
    expect(recallGeometry(CFG, RC).rowsPerPage * DEFAULT_RECALL_CONFIG.pages)
      .toBeGreaterThan(2 * 9);
  });

  it('starts the cells at the left margin', () => {
    expect(recallGeometry(DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG).originXMm)
      .toBeCloseTo(DEFAULT_SHEET_CONFIG.marginLeftMm, 5);
  });
});

describe('renderRecallPages', () => {
  it('prints the first-cell protocol on the page', () => {
    const html = renderRecallPages([plan()], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(html).toContain('第一格');
  });

  it('draws empty cells — no model glyph anywhere', () => {
    const html = renderRecallPages([plan()], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(html).not.toContain('市');
  });

  it('splits across pages at the derived rows-per-page', () => {
    const g = recallGeometry(DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    const many = Array.from({ length: g.rowsPerPage + 1 }, () => plan());
    const html = renderRecallPages(many, { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(html.match(/class="page /g)).toHaveLength(2);
  });

  it('renders nothing at all when there is nothing due', () => {
    expect(renderRecallPages([], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG)).toBe('');
  });

  // CRITICAL: the static header text ("写字回忆" and the first-cell protocol) shares 8 of
  // its 9 distinct hanzi with the 1,200-character handwriting list, so any one of them can
  // itself come due for recall. buildCue faithfully blanks the cue — but if the header next
  // to it still prints the bare character, Franco copies the header instead of recalling,
  // and the grader (seeing ink in cell 1) records a false pass.
  it('blanks a header character when it is itself due for recall', () => {
    const one = plan({ char: '一', pinyin: 'yī', meaning: 'one', example: undefined });
    const html = renderRecallPages([one], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(html).not.toContain('一');
  });

  it('blanks every header hanzi that collides with a due character, not just the cue', () => {
    // 写 and 字 both sit in the page title/head as well as being handwriting characters.
    const xie = plan({ char: '写', pinyin: 'xiě', meaning: 'to write', example: undefined });
    const zi = plan({ char: '字', pinyin: 'zì', meaning: 'character', example: undefined });
    const html = renderRecallPages([xie, zi], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    expect(html).not.toContain('写');
    expect(html).not.toContain('字');
  });
});

describe('renderSolutionsPage', () => {
  it('blanks its own header, because answers pages are interleaved', () => {
    // The rows on this page show answers — that is the page's job. Its HEADER must not,
    // because answers page 1 now sits between recall page 1 and recall page 2, so any
    // answer named in the header is handed over before the row that asks for it. 答, 案,
    // 对, 写, 字 and 回 all appear in the header text and are all handwriting characters.
    const html = renderSolutionsPage(
      [plan({ char: '回' }), plan({ char: '答' })],
      { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    const head = html.match(/<div class="sol-head"[\s\S]*?<\/div>/)![0];
    expect(head).not.toContain('回');
    expect(head).not.toContain('答');
  });

  it('draws no cell outline around an answer', () => {
    // One user unit is 0.125mm here, so a hairline rect rasterises unevenly — solid on one
    // edge, nearly absent on another — and reads as a rendering fault. Position already
    // carries the alignment with the recall page.
    const html = renderSolutionsPage(
      [plan()], { date: '2026-08-22' }, DEFAULT_SHEET_CONFIG, DEFAULT_RECALL_CONFIG);
    const cells = html.match(/<div class="sol-glyph"[\s\S]*?<\/div>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).not.toContain('<rect');
  });

  const two = [plan(), plan({ char: '城' })];
  const html = renderSolutionsPage(two, { date: '2026-08-22' }, CFG, RC);

  // A system font would draw a different 楷体 from the one the drill sheet teaches, on the
  // one page whose whole job is to show the correct form.
  it('draws each answer from the same stroke outlines the drill model uses', () => {
    for (const char of ['市', '城']) {
      expect(html).toContain(glyphPaths(loadGlyph(char)!, { fill: '#000' }));
    }
  });

  it('draws each answer at the size of a practice cell', () => {
    const g = recallGeometry(CFG, RC);
    const box = /class="sol-glyph" style="[^"]*width:([\d.]+)mm;height:([\d.]+)mm/.exec(html)!;
    expect(Number(box[1])).toBeCloseTo(g.cellMm, 2);
    expect(Number(box[2])).toBeCloseTo(g.cellMm, 2);
  });

  // Franco flips between this page and the recall page in front of it, so answer n has to
  // sit exactly where row n's first cell was.
  it('lines each answer up with the recall row that asked for it', () => {
    const g = recallGeometry(CFG, RC);
    expectMm(topsOf(html, 'sol-glyph'), [g.originYMm, g.originYMm + g.rowPitchMm]);
    expectMm(leftsOf(html, 'sol-glyph'), [g.originXMm, g.originXMm]);
  });

  it('keeps the pinyin and meaning beside the glyph', () => {
    expect(html).toContain('shì');
    expect(html).toContain('city; market');
  });

  it('falls back to the character itself when the dataset has no strokes for it', () => {
    const odd = renderSolutionsPage([plan({ char: '𰻞' })], { date: '2026-08-22' }, CFG, RC);
    expect(odd).toContain('𰻞');
  });

  it('paginates in step with the recall pages so the alignment survives page two', () => {
    const g = recallGeometry(CFG, RC);
    const many = Array.from({ length: g.rowsPerPage + 1 }, () => plan());
    const paged = renderSolutionsPage(many, { date: '2026-08-22' }, CFG, RC);
    expect(paged.match(/class="page /g)).toHaveLength(2);
    // The overflow answer restarts at row 0 of page two, not below the bottom margin.
    expect(topsOf(paged, 'sol-glyph').at(-1)).toBeCloseTo(g.originYMm, 5);
  });

  it('renders nothing when there is nothing to answer', () => {
    expect(renderSolutionsPage([], { date: '2026-08-22' }, CFG, RC)).toBe('');
  });
});

// The answers page is the page Franco turns to right after failing to recall a character,
// so "what does it look like" is not the whole question — "how do I write it" is. The drill
// rows already answer that with a stroke-order filmstrip; this puts the same one here.
describe('renderSolutionsPage — stroke order', () => {
  const three = [plan(), plan({ char: '城' }), plan({ char: '晚' })];
  const html = renderSolutionsPage(three, { date: '2026-08-22' }, CFG, RC);
  const g = recallGeometry(CFG, RC);

  /** Every frame's declared size in mm, from one strip. */
  const framesOf = (strip: string): number[] =>
    [...strip.matchAll(/class="frame" width="([\d.]+)mm"/g)].map((m) => Number(m[1]));

  const stripsOf = (h: string): string[] =>
    h.match(/<div class="sol-strip"[\s\S]*?<\/div>/g) ?? [];

  it('shows a filmstrip beside every answer', () => {
    expect(stripsOf(html)).toHaveLength(3);
  });

  it('draws it from the same stroke outlines the drill row uses', () => {
    // Not a font, not a picture — the same paths, so the answer and the model cannot
    // disagree about the shape.
    const strokes = loadGlyph('城')!.strokes;
    expect(stripsOf(html)[1]!).toContain(strokes[0]!);
    expect(stripsOf(html)[1]!).toContain(strokes.at(-1)!);
  });

  it('gives one frame per stroke', () => {
    expect(framesOf(stripsOf(html)[0]!)).toHaveLength(loadGlyph('市')!.strokes.length);
  });

  it('keeps the whole strip inside the printable width', () => {
    const boxes = [...html.matchAll(
      /class="sol-strip" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm;height:([\d.]+)mm/g)];
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      expect(Number(b[1]) + Number(b[3])).toBeLessThanOrEqual(CFG.pageWidthMm - CFG.marginRightMm + 0.001);
    }
    // And the frames themselves fit the box they are in, rather than relying on the
    // container's overflow to hide the ones that do not.
    for (const [i, strip] of stripsOf(html).entries()) {
      const frames = framesOf(strip);
      const used = frames.reduce((a, b) => a + b, 0) + Math.max(0, frames.length - 1) * 0.3;
      expect(used).toBeLessThanOrEqual(Number(boxes[i]![3]) + 0.001);
    }
  });

  it('does not crowd the reading, which keeps its own line above the strip', () => {
    const metaTop = topsOf(html, 'sol-meta');
    const stripTop = topsOf(html, 'sol-strip');
    const rowTops = [0, 1, 2].map((i) => g.originYMm + i * g.rowPitchMm);
    expectMm(metaTop, rowTops);
    expect(stripTop).toHaveLength(3);
    for (const [i, top] of stripTop.entries()) expect(top).toBeGreaterThan(metaTop[i]!);
  });

  it('keeps the strip inside its own row, clear of the next answer', () => {
    const boxes = [...html.matchAll(/class="sol-strip" style="[^"]*top:([\d.]+)mm;width:[\d.]+mm;height:([\d.]+)mm/g)];
    expect(boxes).toHaveLength(3);
    for (const [i, b] of boxes.entries()) {
      const rowTop = g.originYMm + i * g.rowPitchMm;
      expect(Number(b[1]) + Number(b[2])).toBeLessThanOrEqual(rowTop + g.cellMm + 0.001);
    }
  });

  it('draws it bigger than the drill row does, having a whole row to spend', () => {
    // The drill row squeezes its filmstrip into 3.8mm of header. This page has no header
    // to squeeze into, and it is the page whose job is to teach the form.
    const size = framesOf(stripsOf(html)[0]!)[0]!;
    expect(size).toBeGreaterThan(CFG.filmstripMm);
  });

  it('omits the strip rather than faking one when there is no stroke data', () => {
    const odd = renderSolutionsPage([plan({ char: '𰻞' })], { date: '2026-08-22' }, CFG, RC);
    expect(odd).toContain('𰻞');
    expect(odd).not.toContain('class="sol-strip"');
  });

  it('fits a stored geometry\'s smaller cell too', () => {
    const older: RecallGeometry = {
      cellMm: 12.499999999999998, originXMm: 14, originYMm: 15.4, rowPitchMm: 18.77,
      cellsPerRow: 6, rowsPerPage: 10, firstCellGapMm: 2.5,
    };
    const stored = renderSolutionsPage(three, { date: '2026-08-24' }, CFG, RC, older);
    const boxes = [...stored.matchAll(
      /class="sol-strip" style="left:([\d.]+)mm;top:([\d.]+)mm;width:([\d.]+)mm;height:([\d.]+)mm/g)];
    expect(boxes).toHaveLength(3);
    for (const [i, b] of boxes.entries()) {
      expect(Number(b[1]) + Number(b[3])).toBeLessThanOrEqual(CFG.pageWidthMm - CFG.marginRightMm + 0.001);
      expect(Number(b[2]) + Number(b[4]))
        .toBeLessThanOrEqual(older.originYMm + i * older.rowPitchMm + older.cellMm + 0.001);
    }
  });
});

describe('renderSolutionsPage — the header', () => {
  const html = renderSolutionsPage([plan()], { date: '2026-08-22' }, CFG, RC);

  it('says at a glance that this is the answers page', () => {
    expect(html).toContain('答案');
  });

  it('carries the same date and family as the recall header', () => {
    expect(html).toContain('2026-08-22');
    expect(html).toContain('写字回忆');
  });

  it('sits in the same box as the recall page\'s header', () => {
    const recall = renderRecallPages([plan()], { date: '2026-08-22' }, CFG, RC);
    const box = (h: string, cls: string) =>
      new RegExp(`class="${cls}" style="([^"]*)"`).exec(h)![1];
    expect(box(html, 'sol-head')).toBe(box(recall, 'rc-head'));
  });

  // This page's ROWS print the answers on purpose. Its HEADER must not, and that changed
  // when the answers pages were interleaved: answers page 1 now sits between recall page 1
  // and recall page 2, so a header naming an answer hands it over before the row that asks
  // for it. 写, 字, 回, 答, 案 and 对 all appear in the header text and are all handwriting
  // characters, so this is reachable rather than theoretical.
  it('blanks a header character that is itself an answer', () => {
    const xie = plan({ char: '写', pinyin: 'xiě', meaning: 'to write', example: undefined });
    const head = /<div class="sol-head"[\s\S]*?<\/div>/.exec(
      renderSolutionsPage([xie], { date: '2026-08-22' }, CFG, RC),
    )![0];
    expect(head).not.toContain('写');
    expect(head).toContain('＿');
  });

  it('still prints the answer itself in the row below', () => {
    const xie = plan({ char: '写', pinyin: 'xiě', meaning: 'to write', example: undefined });
    const html = renderSolutionsPage([xie], { date: '2026-08-22' }, CFG, RC);
    const rows = html.slice(html.indexOf('</div>', html.indexOf('sol-head')));
    expect(rows).toContain('xiě');
  });
});

describe('renderRecallPages — the graded first cell', () => {
  const html = renderRecallPages([plan()], { date: '2026-08-22' }, CFG, RC);
  const g = recallGeometry(CFG, RC);

  it('draws the first cell separately from the rest', () => {
    expect(html.match(/class="rc-first"/g)).toHaveLength(1);
    expect(html.match(/class="rc-cells"/g)).toHaveLength(1);
  });

  it('gives the first cell a heavier border than the rest', () => {
    const strokeOf = (cls: string) => {
      const svg = html.split(`class="${cls}"`)[1]!.split('</div>')[0]!;
      return Number(/<rect[^>]*stroke-width="([\d.]+)"/.exec(svg)![1]);
    };
    expect(strokeOf('rc-first')).toBeGreaterThan(strokeOf('rc-cells'));
  });

  it('starts the rest of the row after the gap', () => {
    expectMm(leftsOf(html, 'rc-first'), [g.originXMm]);
    expectMm(leftsOf(html, 'rc-cells'), [g.originXMm + g.cellMm + g.firstCellGapMm!]);
  });

  // Per-cell svgs were tried and rounded into visible seams; the remaining cells stay one
  // element. The first cell may be its own because it is deliberately separated anyway.
  it('keeps the remaining cells as a single svg', () => {
    const rest = html.split('class="rc-cells"')[1]!.split('</div>')[0]!;
    expect(rest.match(/<svg/g)).toHaveLength(1);
  });
});

// Every element on these pages is placed in absolute millimetres, and an inline `left:`
// on an element the stylesheet forgot to position does not fail loudly — it silently
// reverts to flow layout and stacks up the left edge of the page. That is what a whole
// column of first cells did on the first print of this change.
describe('renderRecallPages — a row of nothing but the graded cell', () => {
  // cellsPerRow of 1 leaves no cells after the gap. An svg of zero columns draws a
  // negative-width frame, which is malformed rather than empty.
  it('omits the rest of the row rather than drawing an empty grid', () => {
    const html = renderRecallPages([plan()], { date: '2026-08-22' }, CFG, { ...RC, cellsPerRow: 1 });
    expect(html).toContain('class="rc-first"');
    expect(html).not.toContain('class="rc-cells"');
    expect(html).not.toContain('width="-');
  });
});

describe('absolutely placed elements must actually be positioned', () => {
  const documents = [
    renderRecallPages([plan(), plan({ char: '城' })], { date: '2026-08-22' }, CFG, RC),
    renderSolutionsPage([plan(), plan({ char: '城' })], { date: '2026-08-22' }, CFG, RC),
  ];

  it('declares position:absolute for every class placed with an inline left', () => {
    for (const html of documents) {
      const placed = new Set([...html.matchAll(/class="([\w-]+)" style="left:/g)].map((m) => m[1]!));
      expect(placed.size).toBeGreaterThan(2);
      for (const cls of placed) {
        const positioned = new RegExp(`\\.${cls} \\{[^}]*position: absolute`).test(html);
        expect(`${cls} positioned: ${positioned}`).toBe(`${cls} positioned: true`);
      }
    }
  });
});

describe('rendering with a stored geometry', () => {
  // A manifest records the layout a sheet was actually printed with, and grading maps ink
  // onto that record. Reprinting a date with today's geometry instead would score ink
  // against rows that are no longer where the manifest says they are.
  const older: RecallGeometry = {
    cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2,
    cellsPerRow: 6, rowsPerPage: 10,
  };
  const two = [plan(), plan({ char: '城' })];

  it('honours a stored pitch instead of recomputing the current one', () => {
    const html = renderRecallPages(two, { date: '2026-08-22' }, CFG, RC, older);
    expectMm(topsOf(html, 'rc-cells'), [15.4, 32.6]);
  });

  it('honours a stored layout with no first-cell gap at all', () => {
    const html = renderRecallPages(two, { date: '2026-08-22' }, CFG, RC, older);
    expectMm(leftsOf(html, 'rc-cells'), [26.5, 26.5]);
  });

  it('aligns the answers page with the stored geometry too', () => {
    const html = renderSolutionsPage(two, { date: '2026-08-22' }, CFG, RC, older);
    expectMm(topsOf(html, 'sol-glyph'), [15.4, 32.6]);
  });
});

// Verbatim from state/sheets.json — the geometry four already-printed sheets (2026-08-24
// through 2026-08-27) were printed with, back when the bottom margin was 18mm to clear the
// device's page-navigation strip. Those pages are physically on the device and are still
// graded against this record, so shrinking the margin must not move a single one of their
// cells. Copied rather than derived on purpose: a derived expectation would move in step
// with the config and prove nothing.
describe('a sheet already printed keeps the geometry it was printed with', () => {
  const printed: RecallGeometry = {
    cellMm: 12.499999999999998,
    originXMm: 14,
    originYMm: 15.4,
    rowPitchMm: 18.77,
    cellsPerRow: 6,
    rowsPerPage: 10,
    firstCellGapMm: 2.5,
  };
  const rows = [plan(), plan({ char: '城' }), plan({ char: '晚' })];

  it('reprints the recall cells exactly where the manifest says they are', () => {
    const html = renderRecallPages(rows, { date: '2026-08-24' }, CFG, RC, printed);
    expectMm(topsOf(html, 'rc-first'), [15.4, 34.17, 52.94]);
    expectMm(leftsOf(html, 'rc-first'), [14, 14, 14]);
    // First cell 12.5mm wide plus the 2.5mm gap: the rest of the row starts at 29mm.
    expectMm(leftsOf(html, 'rc-cells'), [29, 29, 29]);
  });

  it('reprints the answers on the same stored rows', () => {
    const html = renderSolutionsPage(rows, { date: '2026-08-24' }, CFG, RC, printed);
    expectMm(topsOf(html, 'sol-glyph'), [15.4, 34.17, 52.94]);
    const box = /class="sol-glyph" style="[^"]*width:([\d.]+)mm;height:([\d.]+)mm/.exec(html)!;
    expect(Number(box[1])).toBeCloseTo(printed.cellMm, 3);
  });

  it('paginates on the stored rows-per-page, not on today\'s', () => {
    const many = Array.from({ length: printed.rowsPerPage + 1 }, () => plan());
    const html = renderRecallPages(many, { date: '2026-08-24' }, CFG, RC, printed);
    expect(html.match(/class="page /g)).toHaveLength(2);
    expect(topsOf(html, 'rc-first').at(-1)).toBeCloseTo(printed.originYMm, 5);
  });
});

// "城＿ chéngshì — city" says which word, not which half of it. With the answer blanked
// there is nothing marking which syllable belongs to the blank, and 城市 is exactly as good
// a cue for 城 as for 市. Emboldening the target's own syllable is the whole difference
// between "write the missing character" and "write one of these two".
describe('buildCue — emboldening the target\'s syllable', () => {
  const chengshi = { term: '城市', pinyin: 'chéngshì', syllables: ['chéng', 'shì'], meaning: 'city' };

  it('bolds the syllable of the character being asked for', () => {
    const cue = buildCue(plan({ char: '市', example: chengshi }), 'gap');
    expect(cue).toContain('chéng<b>shì</b>');
  });

  it('bolds the first syllable when the target is the first character', () => {
    const cue = buildCue(plan({ char: '城', example: chengshi }), 'gap');
    expect(cue).toContain('<b>chéng</b>shì');
  });

  it('bolds every occurrence when the character repeats', () => {
    const cue = buildCue(
      plan({ char: '天', example: { term: '天天', pinyin: 'tiāntiān', syllables: ['tiān', 'tiān'], meaning: 'every day' } }),
      'gap',
    );
    expect(cue).toContain('<b>tiān</b><b>tiān</b>');
  });

  // Erhua and a few other entries do not have one syllable per hanzi. Bolding by index
  // there would embolden the wrong half of the word, which is worse than not bolding at
  // all: it would point at a character the row is not asking for.
  it('prints the cue exactly as before when the counts disagree', () => {
    const mismatched = { term: '一下儿', pinyin: 'yíxiàr', syllables: ['yí', 'xiàr'], meaning: 'a bit' };
    const cue = buildCue(plan({ char: '下', example: mismatched }), 'gap');
    expect(cue).not.toContain('<b>');
    expect(cue).toContain('yíxiàr');
  });

  it('prints the cue exactly as before when the dictionary gave no syllables', () => {
    const cue = buildCue(plan(), 'gap');
    expect(cue).not.toContain('<b>');
    expect(cue).toContain('chéngshì');
  });

  it('escapes each syllable, so the bolding cannot be a way in for markup', () => {
    const nasty = { term: '城市', pinyin: 'x', syllables: ['<script>', 'shì'], meaning: 'city' };
    expect(buildCue(plan({ char: '城', example: nasty }), 'gap')).not.toContain('<script>');
  });

  // The bare-character cue has one syllable and nothing to disambiguate it from, so all of
  // it is the target's — bolding it keeps the two cue styles reading alike.
  it('bolds the whole reading in the bare-character cue', () => {
    expect(buildCue(plan({ example: undefined }), 'gap')).toContain('<b>shì</b>');
  });

  it('still never prints the answer itself', () => {
    for (const p of [plan({ example: chengshi }), plan({ char: '城', example: chengshi })]) {
      expect(buildCue(p, 'gap', new Set(['市', '城']))).not.toContain(p.char);
    }
  });

  it('bolds under a sheet-wide answer set too', () => {
    const cue = buildCue(plan({ char: '市', example: chengshi }), 'gap', new Set(['市', '城']));
    expect(cue).toContain('chéng<b>shì</b>');
  });
});

describe('recallStyles — the emboldened syllable', () => {
  it('gives the bold syllable a rule of its own, not just the browser default', () => {
    // The reading is set in grey inside `.rc-cue i`; bold alone inside grey is a weak
    // signal on e-ink, and this is the mark that says which character is being asked for.
    expect(recallStyles(CFG)).toMatch(/\.rc-cue i b\s*\{/);
  });
});
