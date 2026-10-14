import { describe, it, expect } from 'vitest';
import { renderPracticeSheet } from './sheet.js';
import { DEFAULT_SHEET_CONFIG } from './layout.js';
import { DEFAULT_RECALL_CONFIG, recallGeometry, type RecallPlan } from './recall.js';
import type { CharacterPlan } from '../select/enrich.js';

const CFG = DEFAULT_SHEET_CONFIG;
const RC = DEFAULT_RECALL_CONFIG;

const drill = (char: string): CharacterPlan => ({
  char, pinyin: 'guàn', meaning: 'accustomed to', strokeCount: 11, reason: 'linear',
});

const recallPlan = (char: string): RecallPlan => ({
  char, pinyin: 'shì', meaning: 'city; market',
  example: { term: '城市', pinyin: 'chéngshì', meaning: 'city' },
});

/** Each page's kind, in the order the document lays them out. */
function pageKinds(html: string): string[] {
  return [...html.matchAll(/class="page ([\w-]+)"/g)].map((m) => m[1]!);
}

function sheet(recallPlans: readonly RecallPlan[]): string {
  return renderPracticeSheet({
    plans: [drill('惯')],
    recallPlans,
    meta: { date: '2026-11-10', mode: 'linear' },
    config: CFG,
    recall: RC,
  });
}

// Franco writes a recall page, then wants to check it. With the answers stacked behind
// BOTH recall pages he has to page past work he has not done yet to mark work he has —
// and paging past a recall page is paging past its answers' own cues.
describe('renderPracticeSheet — an answers page follows the page it answers', () => {
  const g = recallGeometry(CFG, RC);

  it('interleaves one recall page with one answers page', () => {
    expect(pageKinds(sheet([recallPlan('市')]))).toEqual(['rc-page', 'sol-page', 'page-drill']);
  });

  it('interleaves both pages of a two-page recall section', () => {
    const many = Array.from({ length: g.rowsPerPage + 1 }, (_, i) => recallPlan(i === 0 ? '市' : '城'));
    expect(pageKinds(sheet(many)))
      .toEqual(['rc-page', 'sol-page', 'rc-page', 'sol-page', 'page-drill']);
  });

  it('still renders the drill sheet alone when nothing is due', () => {
    expect(pageKinds(sheet([]))).toEqual(['page-drill']);
  });

  // The link between a cue and its answer is position, not a printed row number: answer n
  // sits exactly where row n's first cell was on the page in front of it. Interleaving must
  // not disturb that — the answers page after recall page 2 has to carry page 2's rows, not
  // page 1's.
  it('keeps each answers page carrying its own recall page\'s rows', () => {
    const many = Array.from({ length: g.rowsPerPage + 1 }, () => recallPlan('市'));
    const pages = sheet(many).split('<div class="page ').slice(1);
    const count = (page: string, cls: string) => (page.match(new RegExp(`class="${cls}"`, 'g')) ?? []).length;

    expect(count(pages[0]!, 'rc-cue')).toBe(g.rowsPerPage);
    expect(count(pages[1]!, 'sol-glyph')).toBe(g.rowsPerPage);
    // The single overflow row, and its single answer, on the pair of pages after them.
    expect(count(pages[2]!, 'rc-cue')).toBe(1);
    expect(count(pages[3]!, 'sol-glyph')).toBe(1);
  });
});

// Six sheets already on the device were printed with the answers stacked behind both
// recall pages, and their manifests record the page indices that document actually had.
// Reprinting one of those dates with today's order would move its recall pages out from
// under its own manifest, and `grade` believes the manifest.
describe('renderPracticeSheet — reprinting a sheet from before the interleave', () => {
  const g = recallGeometry(CFG, RC);
  const many = Array.from({ length: g.rowsPerPage + 1 }, () => recallPlan('市'));

  const stacked = renderPracticeSheet({
    plans: [drill('惯')],
    recallPlans: many,
    meta: { date: '2026-08-28', mode: 'linear' },
    config: CFG,
    recall: RC,
    recallPageOrder: 'stacked',
  });

  it('puts both answers pages behind both recall pages, as that sheet was printed', () => {
    expect(pageKinds(stacked))
      .toEqual(['rc-page', 'rc-page', 'sol-page', 'sol-page', 'page-drill']);
  });

  it('interleaves by default, so only an explicit reprint gets the old order', () => {
    expect(pageKinds(sheet(many)))
      .toEqual(['rc-page', 'sol-page', 'rc-page', 'sol-page', 'page-drill']);
  });
});
