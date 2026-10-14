/**
 * Google's handwriting recogniser (the engine behind Gboard), fed the cell's pen strokes.
 *
 * Undocumented and unauthenticated; Franco accepted sending it anonymous single-character
 * strokes. If it changes or disappears, every call returns null and grading drops to the
 * partner alone (tier 3) without anyone being paged.
 *
 * Best single recogniser on the 2026-09-30 benchmark: 6 wrong verdicts in 101 cells,
 * against 27 for the device transcription.
 */

import { hanOnly, postJson, withRetries, type Recogniser } from './http.js';

export const GOOGLE_URL = 'https://inputtools.google.com/request?itc=zh-t-i0-handwrit&app=xiehanzi';
/** Ink units per millimetre. Only the proportions matter to the recogniser. */
const UNITS_PER_MM = 20;

export function createGoogleRecogniser(
  opts: { fetch?: typeof fetch; timeoutMs?: number; retries?: number } = {},
): Recogniser {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 1;

  return {
    name: 'google',
    async recognise(cell) {
      if (cell.strokes.length === 0) return null;

      const size = Math.round(cell.cellMm * UNITS_PER_MM);
      const ink = cell.strokes.map((s) => [
        s.map((p) => Math.round(p.x * UNITS_PER_MM)),
        s.map((p) => Math.round(p.y * UNITS_PER_MM)),
        [],
      ]);
      const body = {
        options: 'enable_pre_space',
        requests: [{ writing_guide: { writing_area_width: size, writing_area_height: size }, ink, language: 'zh_CN' }],
      };

      return withRetries(retries, async () => {
        const reply = await postJson(fetchImpl, GOOGLE_URL, {}, body, timeoutMs);
        if (!Array.isArray(reply) || reply[0] !== 'SUCCESS') return null;
        const candidates = hanOnly((reply[1] as unknown[][] | undefined)?.[0]?.[1]);
        return candidates.length > 0 ? { source: 'google', candidates } : null;
      });
    },
  };
}
