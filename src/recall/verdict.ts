/**
 * Readings into verdicts. Pure: no network, no clock.
 *
 * Google reads the strokes and is the best single judge of WHAT was written. Its one
 * weakness is snapping a malformed character (样 written with 禾, a rough 能) to the
 * nearest real one. The stroke count catches most of those: on Franco's real history a
 * correctly written character was never two or more strokes away from the reference, and
 * more than half the wrong ones Google passed were. So a Google pass more than
 * `maxStrokeDelta` strokes off is a fail, in every mode.
 *
 * The partner vision model, shown the target printed beside the handwriting, is a second
 * opinion whose use `partnerMode` sets: `off` never asks it (Google and the gate are the
 * whole pipeline), `ambiguous` asks it only about a Google pass exactly one stroke off,
 * `always` asks it about every pass the gate leaves standing, as grading did before the
 * gate. In every mode it is still the degraded fallback when Google is unavailable. It was
 * switched off on 2026-10-01 because it failed more correct characters than it caught.
 *
 * Accepting the expected character from Google's lower ranks is deliberately impossible:
 * on a written 待, Google's third candidate is 持, and "top 3" would pass exactly the
 * confusions recall exists to catch.
 */

import type { Review } from './schedule.js';

/**
 * `candidates`: what was written, best first. `accepts`: set only by a recogniser asked
 * about a specific target (the comparing partner) — true for "this is the target, written
 * correctly", false for "it is not". When set, it decides the partner's side of a pass;
 * the candidates still name the written character for the confusion rule.
 */
export type Reading = { source: string; candidates: string[]; accepts?: boolean };
/** `null`: unavailable. `'not-needed'`: deliberately not asked: the partner mode did not call for it. */
export type PartnerReading = Reading | null | 'not-needed';

export type PartnerMode = 'off' | 'ambiguous' | 'always';

export type VerdictOpts = {
  /** Characters the written one may be confused with. */
  eligible: ReadonlySet<string>;
  /** Whether the confusion rule applies to this date. */
  confusion: boolean;
  /** Strokes written minus the target's reference strokes; null when either is unknown. */
  strokeDelta: number | null;
  /**
   * Strokes written minus the reference strokes of Google's top reading, when that is
   * another character; null otherwise. The confusion rule's second witness when the
   * partner is not asked.
   */
  readDelta: number | null;
  maxStrokeDelta: number;
  partnerMode: PartnerMode;
};

export type CellVerdict = {
  result: 'pass' | 'fail';
  /**
   * 1 = the configured pipeline in full (Google, the gate, and the partner when the mode
   * needed it); 2 = Google alone, the partner needed but unavailable; 3 = partner alone;
   * 4 = device transcription. Anything above 1 is degraded.
   */
  tier: 1 | 2 | 3 | 4;
  read: string | undefined;
  sources: string[];
  /** The character written instead of the one asked, when it should also be failed. */
  confusion: string | null;
};

export const PARTNER_TOP_K = 3;

const top = (r: Reading | null): string | undefined => r?.candidates[0];

/**
 * A reading with no candidates and no acceptance read nothing, so it counts as
 * unavailable. Today's recognisers already return null for that, but the policy must not
 * depend on it: taken at face value, an empty Google reading would be a confident fail
 * with no evidence. A rejection with no candidates ("malformed, not a real character")
 * is evidence, though: it is a fail, never "unavailable".
 */
function usable<R extends PartnerReading>(r: R): R | null {
  return r !== null && r !== 'not-needed' && r.candidates.length === 0 && r.accepts === undefined ? null : r;
}

/** The partner's side of a pass: its acceptance when it gave one, else its top 3. */
const partnerAccepts = (expected: string, partner: Reading): boolean =>
  partner.accepts ?? partner.candidates.slice(0, PARTNER_TOP_K).includes(expected);

/** Within the stroke gate: an unknown delta never fails a cell. */
const withinGate = (delta: number | null, max: number): boolean => delta === null || Math.abs(delta) <= max;

export function partnerNeeded(expected: string, google: Reading | null, opts: VerdictOpts): boolean {
  google = usable(google);
  // In every mode the partner is the fallback without Google: a degraded verdict the
  // nightly run replaces beats none at all.
  if (google === null) return true;
  const read = top(google);
  // A pass the stroke gate fails is settled; nothing the partner says can overturn it.
  const gated = read === expected && !withinGate(opts.strokeDelta, opts.maxStrokeDelta);
  if (opts.partnerMode === 'ambiguous') {
    // Only the cells the stroke count cannot settle: Google passes, one stroke off. Never
    // for the confusion rule, whose second witness is then the stroke count.
    return read === expected && !gated && opts.strokeDelta !== null && Math.abs(opts.strokeDelta) === 1;
  }
  if (opts.partnerMode === 'always') {
    if (read === expected) return !gated;
    return opts.confusion && read !== undefined && opts.eligible.has(read);
  }
  // 'off', and anything unrecognised: never read as 'always'.
  return false;
}

export function decideCell(
  expected: string,
  readings: { google: Reading | null; partner: PartnerReading; device: Reading | null },
  opts: VerdictOpts,
): CellVerdict | null {
  const google = usable(readings.google);
  const device = usable(readings.device);
  const read = top(google);
  // Whether the partner was needed is the mode's call, not the caller's: a reading the mode
  // did not ask for is ignored, and a missing one it did not need is no gap. A partner the
  // mode needed but that was marked 'not-needed' is a gap, so it counts as unavailable.
  const needed = partnerNeeded(expected, readings.google, opts);
  const partner: PartnerReading = !needed ? 'not-needed'
    : readings.partner === 'not-needed' ? null : usable(readings.partner);

  if (google !== null) {
    const googlePass = read === expected;
    // 'strokes' is a source whenever the count was actually compared with the target.
    const sources = googlePass && opts.strokeDelta !== null ? [google.source, 'strokes'] : [google.source];

    if (googlePass && !withinGate(opts.strokeDelta, opts.maxStrokeDelta)) {
      // Nothing can overturn the gate, so no mode asks the partner here: tier 1.
      return { result: 'fail', tier: 1, read, sources, confusion: null };
    }

    if (partner !== null && partner !== 'not-needed') {
      const pass = googlePass && partnerAccepts(expected, partner);
      const agreed = read !== undefined && read === top(partner) && read !== expected;
      const confusion = !pass && opts.confusion && agreed && opts.eligible.has(read) ? read! : null;
      return { result: pass ? 'pass' : 'fail', tier: 1, read, sources: [...sources, partner.source], confusion };
    }

    if (partner === 'not-needed') {
      if (googlePass) return { result: 'pass', tier: 1, read, sources, confusion: null };
      // The partner was not asked, so the stroke count is the second witness that the
      // character Google read is what was actually written.
      const confusion = opts.confusion && read !== undefined && opts.eligible.has(read) &&
        opts.readDelta !== null && withinGate(opts.readDelta, opts.maxStrokeDelta) ? read : null;
      return {
        result: 'fail', tier: 1, read,
        sources: confusion === null ? [google.source] : [google.source, 'strokes'],
        confusion,
      };
    }

    return { result: googlePass ? 'pass' : 'fail', tier: 2, read, sources, confusion: null };
  }

  if (partner !== null && partner !== 'not-needed') {
    const p = top(partner);
    return { result: (partner.accepts ?? p === expected) ? 'pass' : 'fail', tier: 3, read: p, sources: [partner.source], confusion: null };
  }

  if (device !== null) {
    const d = top(device);
    return { result: d === expected ? 'pass' : 'fail', tier: 4, read: d, sources: [device.source], confusion: null };
  }

  return null;
}

/**
 * One verdict per character per date, and a fail beats a pass. Without this a character
 * that passed in its own row and was also written in place of another would replay as
 * fail-then-pass on the same day — counting the lapse yet scheduled as a pass. An own-row
 * verdict is preferred over a confusion one when both are fails, because it says more.
 */
export function mergeDay(reviews: readonly Review[]): Review[] {
  const chosen = new Map<string, Review>();
  for (const r of reviews) {
    const current = chosen.get(r.char);
    if (current === undefined) {
      chosen.set(r.char, r);
      continue;
    }
    const currentIsFail = current.result === 'fail';
    if (r.result === 'fail' && !currentIsFail) chosen.set(r.char, r);
    else if (r.result === 'fail' && currentIsFail && current.evidence === 'confusion' && r.evidence !== 'confusion') {
      chosen.set(r.char, r);
    }
  }
  return [...chosen.values()];
}
