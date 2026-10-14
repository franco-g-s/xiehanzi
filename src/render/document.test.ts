import { describe, it, expect } from 'vitest';
import { frameStyles, composeDocument } from './document.js';
import { renderPracticeSheet } from './sheet.js';
import { sheetStyles, DEFAULT_SHEET_CONFIG, computeMetrics } from './layout.js';
import { recallStyles, solutionStyles, DEFAULT_RECALL_CONFIG, type RecallPlan } from './recall.js';
import type { CharacterPlan } from '../select/enrich.js';

const drill = (char: string): CharacterPlan => ({
  char, pinyin: 'guàn', meaning: 'accustomed to', strokeCount: 11, reason: 'linear',
  example: { term: '习惯', pinyin: 'xíguàn', meaning: 'habit' },
});

const recallPlan = (char: string): RecallPlan => ({
  char, pinyin: 'shì', meaning: 'city; market',
  example: { term: '城市', pinyin: 'chéngshì', meaning: 'city' },
});

const full = () =>
  renderPracticeSheet({
    plans: [drill('惯'), drill('父')],
    recallPlans: [recallPlan('市'), recallPlan('城')],
    meta: { date: '2026-08-19', mode: 'linear' },
    config: DEFAULT_SHEET_CONFIG,
    recall: DEFAULT_RECALL_CONFIG,
  });

/**
 * Selectors a stylesheet defines, one entry per selector in every rule's prelude.
 * Deliberately crude — it only has to be good enough to catch two stylesheets claiming
 * the same name, which is the whole failure mode being guarded here.
 */
const selectorsOf = (css: string): string[] =>
  css
    .split('}')
    .map((block) => block.split('{')[0] ?? '')
    .flatMap((prelude) => prelude.split(','))
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s !== '');

describe('renderPracticeSheet — one document, not three concatenated', () => {
  // The bug this guards: renderSheet, renderRecallPages and renderSolutionsPage each
  // returned a whole document and cli.ts concatenated them. The browser merged all three
  // <style> blocks, so recall's absolutely-positioned .page-head silently reassigned the
  // drill page's header and row 1 printed on top of it.
  it('emits exactly one html, head and style element', () => {
    const html = full();
    expect(html.match(/<html/g)).toHaveLength(1);
    expect(html.match(/<head/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
  });

  it('emits exactly one doctype', () => {
    expect(full().match(/<!doctype/gi)).toHaveLength(1);
  });

  it('carries every page of the sheet in that one document', () => {
    const html = full();
    // 1 recall page + 1 solutions page + 1 drill page.
    expect(html.match(/class="page /g)).toHaveLength(3);
  });

  it('puts the recall pages before the drill pages', () => {
    const html = full();
    expect(html.indexOf('rc-cue')).toBeLessThan(html.indexOf('class="row"'));
  });

  it('renders the drill sheet alone when nothing is due for recall', () => {
    const html = renderPracticeSheet({
      plans: [drill('惯')],
      recallPlans: [],
      meta: { date: '2026-08-19', mode: 'linear' },
      config: DEFAULT_SHEET_CONFIG,
      recall: DEFAULT_RECALL_CONFIG,
    });
    expect(html.match(/class="page /g)).toHaveLength(1);
    expect(html).not.toContain('class="rc-cue"');
  });
});

describe('stylesheets must not collide', () => {
  const m = computeMetrics(DEFAULT_SHEET_CONFIG);
  const sheets: [string, string][] = [
    ['frame', frameStyles(DEFAULT_SHEET_CONFIG)],
    ['drill', sheetStyles(DEFAULT_SHEET_CONFIG, m)],
    ['recall', recallStyles(DEFAULT_SHEET_CONFIG)],
    ['solutions', solutionStyles(DEFAULT_SHEET_CONFIG)],
  ];

  it('defines no selector in more than one stylesheet', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [name, css] of sheets) {
      for (const selector of new Set(selectorsOf(css))) {
        const owner = seen.get(selector);
        if (owner !== undefined) collisions.push(`${selector}: ${owner} and ${name}`);
        else seen.set(selector, name);
      }
    }
    expect(collisions).toEqual([]);
  });

  // The page box itself is shared — bitmap.ts finds pages with `.page` — so only the frame
  // may describe it. A renderer that also styled `.page` is how layout's padding silently
  // offset every absolutely positioned recall element.
  it('leaves the shared page box to the frame stylesheet alone', () => {
    for (const [name, css] of sheets.slice(1)) {
      expect(`${name}: ${selectorsOf(css).filter((s) => s === '.page' || s === 'body' || s === '@page').join()}`)
        .toBe(`${name}: `);
    }
  });
});

describe('composeDocument', () => {
  it('concatenates stylesheets into a single style element', () => {
    const html = composeDocument({ title: 't', styles: ['a { color: red }', 'b { color: blue }'], body: '<p>x</p>' });
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html).toContain('a { color: red }');
    expect(html).toContain('b { color: blue }');
  });

  it('escapes the title so it cannot break out of the head', () => {
    expect(composeDocument({ title: '<script>', styles: [], body: '' })).not.toContain('<script>');
  });
});
