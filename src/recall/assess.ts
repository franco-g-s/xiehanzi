/**
 * One written page into verdicts.
 *
 * Only the first cell of each row is ever graded; the rest are written after checking the
 * solutions page. A graded cell with ink is read by the recognisers. A blank graded cell
 * fails only when the rest of its own row has ink, as it always has. "Any ink is a pass"
 * is gone: on the 2026-09-30 benchmark it had passed 41 wrong answers.
 *
 * Cells are read one at a time, never in parallel: the night has hours, and the machine runs
 * other jobs.
 */

import { decodeRle } from '../deliver/note/rle.js';
import { cellRect, inkFraction, INK_THRESHOLD, transcriptionForRow } from './grade.js';
import { strokesInCell, cellPng } from './cells.js';
import { decideCell, partnerNeeded, type Reading, type PartnerReading, type PartnerMode, type VerdictOpts } from './verdict.js';
import { referenceStrokeCount } from './recognise/reference.js';
import type { ParsedPage } from '../deliver/note/read.js';
import type { RecallGeometry, RecallRow } from '../state/sheets.js';
import type { Recognisers } from './recognise/http.js';
import type { Review } from './schedule.js';

const PX_W = 1920;
const PX_H = 2560;

/**
 * Strokes written minus the reference's, or null when either is unknown: a cell with no
 * pen data (older notes, a page with no TOTALPATH) or a character hanzi-writer-data lacks.
 */
function strokeDelta(written: number, char: string): number | null {
  const reference = referenceStrokeCount(char);
  return written === 0 || reference === null ? null : written - reference;
}

export type TierCounts = { 1: number; 2: number; 3: number; 4: number };

export async function assessPage(args: {
  page: ParsedPage;
  rows: readonly RecallRow[];
  geometry: RecallGeometry;
  date: string;
  pageWidthMm: number;
  pageHeightMm: number;
  recognisers: Recognisers;
  eligible: ReadonlySet<string>;
  confusion: boolean;
  partnerMode: PartnerMode;
  maxStrokeDelta: number;
}): Promise<{ reviews: Review[]; tiers: TierCounts; ungraded: number; ungradedChars: string[] }> {
  const { page, rows, geometry, date, pageWidthMm, pageHeightMm, recognisers, eligible, confusion, partnerMode, maxStrokeDelta } = args;
  const tiers: TierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const reviews: Review[] = [];
  // Which rows, not only how many: a cell that read fine before must keep its earlier
  // verdict rather than vanish from a re-grade that could not read it this time.
  const ungradedChars: string[] = [];

  if (page.writing === null) return { reviews, tiers, ungraded: 0, ungradedChars };
  // Decoded once per page: 4.9 MB, and every row reads from it.
  const pixels = decodeRle(page.writing, PX_W, PX_H);

  for (const row of rows) {
    const rect = cellRect(geometry, row.row, 0);

    if (inkFraction(pixels, pageWidthMm, pageHeightMm, rect) <= INK_THRESHOLD) {
      let restOfRowHasInk = false;
      for (let cell = 1; cell < geometry.cellsPerRow; cell += 1) {
        if (inkFraction(pixels, pageWidthMm, pageHeightMm, cellRect(geometry, row.row, cell)) > INK_THRESHOLD) {
          restOfRowHasInk = true;
          break;
        }
      }
      if (restOfRowHasInk) reviews.push({ date, char: row.char, result: 'fail', evidence: 'ink' });
      continue;
    }

    const cell = {
      strokes: strokesInCell(page.strokes ?? [], geometry, row.row, pageWidthMm, pageHeightMm),
      png: cellPng(pixels, rect, pageWidthMm, pageHeightMm),
      cellMm: geometry.cellMm,
    };

    const google = recognisers.google === null ? null : await recognisers.google.recognise(cell, row.char);
    const read = google?.candidates[0];
    const opts: VerdictOpts = {
      eligible,
      confusion,
      partnerMode,
      maxStrokeDelta,
      strokeDelta: strokeDelta(cell.strokes.length, row.char),
      readDelta: read === undefined || read === row.char ? null : strokeDelta(cell.strokes.length, read),
    };
    let partner: PartnerReading = 'not-needed';
    if (partnerNeeded(row.char, google, opts)) {
      partner = recognisers.partner === null ? null : await recognisers.partner.recognise(cell, row.char);
    }
    // Without Google the partner is asked in every mode, as the fallback, so 'not-needed'
    // only ever sits beside a Google reading.
    const word = page.recognition === null ? null : transcriptionForRow(page.recognition, geometry, row.row);
    const device: Reading | null = word === null ? null : { source: 'device', candidates: [word.label] };

    const verdict = decideCell(row.char, { google, partner, device }, opts);
    if (verdict === null) {
      ungradedChars.push(row.char);
      continue;
    }
    tiers[verdict.tier] += 1;

    reviews.push({
      date,
      char: row.char,
      result: verdict.result,
      evidence: verdict.tier === 4 ? 'transcription' : 'recognition',
      ...(verdict.read === undefined ? {} : { read: verdict.read }),
      sources: verdict.sources,
      ...(verdict.tier > 1 ? { degraded: true } : {}),
    });
    if (verdict.confusion !== null) {
      reviews.push({
        date, char: verdict.confusion, result: 'fail', evidence: 'confusion',
        read: verdict.confusion, asked: row.char, sources: verdict.sources,
      });
    }
  }

  return { reviews, tiers, ungraded: ungradedChars.length, ungradedChars };
}
