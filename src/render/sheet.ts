/**
 * A whole day's sheet as ONE document: each recall page followed immediately by the answers
 * page that answers it, then the drill pages.
 *
 * Order is load-bearing, twice over.
 *
 * Recall comes first because it produces the scheduling signal, and because a relearn
 * character on today's drill pages must already be behind you before its own drill row
 * could spoil it.
 *
 * The answers page sits directly behind its own recall page because that is how the sheet
 * is actually used: write a page, turn over, mark it. With the answers stacked behind BOTH
 * recall pages, checking page 1 meant paging past page 2 — past cues for characters not yet
 * attempted, which weakens them, and past the second answers page, which hands them over
 * outright.
 *
 * This changes which PHYSICAL page a recall page occupies: 0 and 2 rather than 0 and 1.
 * `RecallRow.page` on the manifest is a physical page index into the delivered `.note` and
 * always was — grading indexes `note.pages` with it directly — so cli.ts's row builder is
 * what has to account for the interleave. Manifests written before this change recorded 0
 * and 1, which were the physical indices on the pages actually printed then, so they still
 * grade correctly against the sheets sitting on the device.
 */

import type { CharacterPlan } from '../select/enrich.js';
import type { SheetConfig, SheetMeta } from './layout.js';
import { computeMetrics, sheetFragment, sheetStyles } from './layout.js';
import type { RecallConfig, RecallGeometry, RecallPlan } from './recall.js';
import { recallPages, recallStyles, solutionPages, solutionStyles } from './recall.js';
import { composeDocument, frameStyles } from './document.js';

export function renderPracticeSheet(args: {
  plans: readonly CharacterPlan[];
  recallPlans: readonly RecallPlan[];
  meta: SheetMeta;
  config: SheetConfig;
  recall: RecallConfig;
  /**
   * The layout a manifest already recorded, when regenerating a date that has one.
   * Reprinting with freshly computed geometry would put the cells somewhere the manifest
   * does not describe, and grading maps ink onto the manifest — so a reprint that drifts
   * scores ink against the wrong rows.
   */
  geometry?: RecallGeometry;
  /**
   * Which order the recall and answers pages go in.
   *
   * 'interleaved' is how sheets are printed now, and the default. 'stacked' — every recall
   * page, then every answers page — is only for REPRINTING a date whose manifest was
   * written under that older order: those sheets are on the device with their recall on
   * consecutive pages, their manifests record those indices, and grading believes the
   * manifest. It is the same reason `geometry` is passed rather than recomputed.
   */
  recallPageOrder?: 'interleaved' | 'stacked';
}): string {
  const m = computeMetrics(args.config);
  const { plans, recallPlans, meta, config, recall } = args;

  // The recall stylesheets are included even with nothing due. They cost a few hundred
  // bytes, and making their presence conditional is one more way for the printed page to
  // depend on something other than the markup it is printing.
  return composeDocument({
    title: `写汉字 ${meta.date}`,
    styles: [
      frameStyles(config),
      recallStyles(config),
      solutionStyles(config),
      sheetStyles(config, m),
    ],
    body:
      order(
        recallPages(recallPlans, meta, config, recall, args.geometry),
        solutionPages(recallPlans, meta, config, recall, args.geometry),
        args.recallPageOrder ?? 'interleaved',
      ) + sheetFragment(plans, meta, config, m),
  });
}

/**
 * Recall page 0, answers page 0, recall page 1, answers page 1, … — or, for a reprint of a
 * sheet from before that change, every recall page followed by every answers page.
 *
 * The two lists always come out the same length — both paginate the same rows at the same
 * rows-per-page — but this walks to the longer of the two anyway rather than trusting that
 * invariant to hold silently: a page dropped here is a page of practice that vanishes.
 */
function order(
  recall: readonly string[],
  answers: readonly string[],
  how: 'interleaved' | 'stacked',
): string {
  if (how === 'stacked') return recall.join('') + answers.join('');

  const out: string[] = [];
  for (let i = 0; i < Math.max(recall.length, answers.length); i += 1) {
    if (recall[i] !== undefined) out.push(recall[i]!);
    if (answers[i] !== undefined) out.push(answers[i]!);
  }
  return out.join('');
}

