import { describe, it, expect } from 'vitest';
import { decideCell, partnerNeeded, mergeDay, type Reading } from './verdict.js';
import type { Review } from './schedule.js';

const g = (...c: string[]): Reading => ({ source: 'google', candidates: c });
const p = (...c: string[]): Reading => ({ source: 'go:grok-4.6', candidates: c });
/** The comparing partner: it accepts or rejects the target, and says what was written. */
const pa = (accepts: boolean, ...c: string[]): Reading => ({ source: 'go:grok-4.6', candidates: c, accepts });
const dev = (label: string): Reading => ({ source: 'device', candidates: [label] });
const eligible = new Set(['持', '待', '做', '作', '成', '程']);
/** Today's policy, with no stroke data: every test written before the stroke gate. */
const strokes = { strokeDelta: null, readDelta: null, maxStrokeDelta: 1, partnerMode: 'always' } as const;
const on = { eligible, confusion: true, ...strokes };
const off = { eligible, confusion: false, ...strokes };

describe('decideCell — tier 1, Google and the partner', () => {
  it('passes when Google reads the character and the partner has it in its top 3', () => {
    expect(decideCell('还', { google: g('还'), partner: p('远', '这', '还'), device: null }, on))
      .toMatchObject({ result: 'pass', tier: 1, read: '还', sources: ['google', 'go:grok-4.6'] });
  });

  it('fails a malformed character Google snaps to the answer but the partner rejects', () => {
    expect(decideCell('能', { google: g('能'), partner: p('削', '创', '别'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 1 });
  });

  it('never accepts the expected character from Google\'s lower ranks: 持 is #3 for a written 待', () => {
    expect(decideCell('持', { google: g('待', '侍', '持'), partner: p('待'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 1, read: '待' });
  });

  it('fails without asking the partner when Google reads something else', () => {
    expect(decideCell('百', { google: g('白'), partner: 'not-needed', device: null }, off))
      .toMatchObject({ result: 'fail', tier: 1, sources: ['google'], confusion: null });
  });
});

describe('decideCell — confusion', () => {
  it('names the written character when both readers agree on it and it is eligible', () => {
    expect(decideCell('持', { google: g('待'), partner: p('待'), device: null }, on)!.confusion).toBe('待');
  });

  it('names nothing when the readers disagree on what was written', () => {
    expect(decideCell('持', { google: g('待'), partner: p('侍'), device: null }, on)!.confusion).toBeNull();
  });

  it('names nothing for a radical or a character outside the recall pool', () => {
    expect(decideCell('续', { google: g('纟'), partner: p('纟'), device: null }, on)!.confusion).toBeNull();
  });

  it('names nothing before the rule starts', () => {
    expect(decideCell('持', { google: g('待'), partner: p('待'), device: null }, off)!.confusion).toBeNull();
  });

  it('names nothing on a pass', () => {
    expect(decideCell('做', { google: g('做'), partner: p('做'), device: null }, on)!.confusion).toBeNull();
  });
});

describe('decideCell — fallback tiers', () => {
  it('tier 2: Google alone when the partner is unavailable', () => {
    expect(decideCell('真', { google: g('真'), partner: null, device: dev('直') }, on))
      .toMatchObject({ result: 'pass', tier: 2, sources: ['google'], confusion: null });
  });

  it('tier 3: the partner alone, top 1 only, when Google is unavailable', () => {
    expect(decideCell('真', { google: null, partner: p('直', '真'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 3, read: '直' });
  });

  it('tier 4: the device transcription when both recognisers are unavailable', () => {
    expect(decideCell('真', { google: null, partner: null, device: dev('真') }, on))
      .toMatchObject({ result: 'pass', tier: 4, sources: ['device'] });
  });

  it('no verdict at all when nothing is available', () => {
    expect(decideCell('真', { google: null, partner: null, device: null }, on)).toBeNull();
  });

  it('treats a partner that was not needed but Google missing as tier 4/none, not a pass', () => {
    expect(decideCell('真', { google: null, partner: 'not-needed', device: null }, on)).toBeNull();
  });
});

describe('decideCell — an empty reading is no reading', () => {
  // A recogniser that answers with no candidates has read nothing. Taking it as a
  // confident fail would be a verdict with no evidence behind it.
  it('treats empty candidate lists as unavailable, from either reader', () => {
    expect(decideCell('真', { google: g(), partner: p('真'), device: null }, on))
      .toMatchObject({ result: 'pass', tier: 3 });
    expect(decideCell('真', { google: g('真'), partner: p(), device: null }, on))
      .toMatchObject({ result: 'pass', tier: 2 });
    expect(decideCell('真', { google: g(), partner: 'not-needed', device: null }, on)).toBeNull();
    expect(partnerNeeded('真', g(), off)).toBe(true);
  });
});

describe('decideCell — a partner that accepts or rejects the target', () => {
  it('passes tier 1 on acceptance, even with no candidates', () => {
    expect(decideCell('还', { google: g('还'), partner: pa(true), device: null }, on))
      .toMatchObject({ result: 'pass', tier: 1, read: '还' });
  });

  it('fails tier 1 on rejection, even if the candidates contain the target', () => {
    expect(decideCell('样', { google: g('样'), partner: pa(false, '样'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 1, read: '样' });
  });

  it('tier 3 follows the acceptance, reading the written character when there is one', () => {
    expect(decideCell('真', { google: null, partner: pa(true, '真'), device: null }, on))
      .toMatchObject({ result: 'pass', tier: 3, read: '真' });
    expect(decideCell('真', { google: null, partner: pa(false, '直'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 3, read: '直' });
  });

  it('counts a rejection with no candidates as a fail, never as unavailable', () => {
    expect(decideCell('样', { google: g('样'), partner: pa(false), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 1, sources: ['google', 'go:grok-4.6'] });
    const alone = decideCell('样', { google: null, partner: pa(false), device: dev('样') }, on);
    expect(alone).toMatchObject({ result: 'fail', tier: 3 });
    expect(alone!.read).toBeUndefined();
  });

  it('still finds a confusion when the partner rejects and says 待 was written', () => {
    expect(decideCell('持', { google: g('待'), partner: pa(false, '待'), device: null }, on))
      .toMatchObject({ result: 'fail', tier: 1, confusion: '待' });
  });
});

describe('decideCell — the stroke-count gate', () => {
  // On 412 cells written correctly, Franco's stroke count was never 2+ away from the
  // reference; on 11 written wrong, 6 were. So |delta| > 1 fails a Google pass outright.
  const gate = (strokeDelta: number | null, partnerMode: 'off' | 'ambiguous' | 'always' = 'off') =>
    ({ ...on, strokeDelta, partnerMode });

  it('fails a Google pass two strokes off the reference, either way', () => {
    for (const d of [2, -2, 5]) {
      expect(decideCell('还', { google: g('还'), partner: 'not-needed', device: null }, gate(d)))
        .toEqual({ result: 'fail', tier: 1, read: '还', sources: ['google', 'strokes'], confusion: null });
    }
  });

  it('passes a Google pass within one stroke, and says the strokes were checked', () => {
    for (const d of [-1, 0, 1]) {
      expect(decideCell('还', { google: g('还'), partner: 'not-needed', device: null }, gate(d)))
        .toEqual({ result: 'pass', tier: 1, read: '还', sources: ['google', 'strokes'], confusion: null });
    }
  });

  it('never fails a cell on an unknown delta (no strokes, or no reference)', () => {
    expect(decideCell('还', { google: g('还'), partner: 'not-needed', device: null }, gate(null)))
      .toEqual({ result: 'pass', tier: 1, read: '还', sources: ['google'], confusion: null });
  });

  it('applies under always too, whatever the partner said', () => {
    expect(decideCell('还', { google: g('还'), partner: pa(true, '还'), device: null }, gate(3, 'always')))
      .toMatchObject({ result: 'fail', tier: 1, sources: ['google', 'strokes'] });
    // The partner is not even asked about a gated cell, so its absence degrades nothing.
    expect(decideCell('还', { google: g('还'), partner: null, device: null }, gate(3, 'always')))
      .toMatchObject({ result: 'fail', tier: 1, sources: ['google', 'strokes'] });
  });

  it('honours a different limit', () => {
    expect(decideCell('还', { google: g('还'), partner: 'not-needed', device: null }, { ...gate(1), maxStrokeDelta: 0 }))
      .toMatchObject({ result: 'fail' });
  });
});

describe('partner modes', () => {
  const mode = (partnerMode: 'off' | 'ambiguous' | 'always', strokeDelta: number | null) =>
    ({ ...on, partnerMode, strokeDelta });

  describe('off', () => {
    it('never asks the partner about anything Google read', () => {
      expect(partnerNeeded('还', g('还'), mode('off', 1))).toBe(false);
      expect(partnerNeeded('还', g('还'), mode('off', null))).toBe(false);
      expect(partnerNeeded('持', g('待'), mode('off', null))).toBe(false);
    });

    it('still asks the partner when Google is unavailable: a degraded fallback beats none', () => {
      expect(partnerNeeded('还', null, mode('off', null))).toBe(true);
      expect(partnerNeeded('还', g(), mode('off', null))).toBe(true);
    });

    it('is the full pipeline: Google and the gate decide, tier 1, not degraded', () => {
      expect(decideCell('还', { google: g('还'), partner: 'not-needed', device: null }, mode('off', 0)))
        .toMatchObject({ result: 'pass', tier: 1 });
      // Even handed a null partner (as the eval script does), it was never needed.
      expect(decideCell('还', { google: g('还'), partner: null, device: null }, mode('off', 1)))
        .toMatchObject({ result: 'pass', tier: 1 });
    });

    it('ignores a partner reading it did not ask for', () => {
      expect(decideCell('还', { google: g('还'), partner: pa(false), device: null }, mode('off', 0)))
        .toEqual({ result: 'pass', tier: 1, read: '还', sources: ['google', 'strokes'], confusion: null });
    });

    it('without Google, the partner alone decides, degraded; without either, the device', () => {
      expect(decideCell('真', { google: null, partner: pa(true, '真'), device: dev('直') }, mode('off', null)))
        .toMatchObject({ result: 'pass', tier: 3 });
      expect(decideCell('真', { google: null, partner: null, device: dev('真') }, mode('off', null)))
        .toMatchObject({ result: 'pass', tier: 4 });
    });
  });

  describe('ambiguous', () => {
    it('asks only when Google passes and the count is exactly one off', () => {
      expect(partnerNeeded('还', g('还'), mode('ambiguous', 1))).toBe(true);
      expect(partnerNeeded('还', g('还'), mode('ambiguous', -1))).toBe(true);
      expect(partnerNeeded('还', g('还'), mode('ambiguous', 0))).toBe(false);
      expect(partnerNeeded('还', g('还'), mode('ambiguous', null))).toBe(false);
      expect(partnerNeeded('还', g('还'), mode('ambiguous', 2))).toBe(false);
      // Never for the confusion check: the stroke count is the second witness there.
      expect(partnerNeeded('持', g('待'), mode('ambiguous', null))).toBe(false);
    });

    it('asks when Google is unavailable, as the fallback', () => {
      expect(partnerNeeded('还', null, mode('ambiguous', null))).toBe(true);
      expect(decideCell('真', { google: null, partner: pa(false, '直'), device: null }, mode('ambiguous', null)))
        .toMatchObject({ result: 'fail', tier: 3 });
    });

    it('does not ask at delta 1 when the limit already fails it', () => {
      expect(partnerNeeded('还', g('还'), { ...mode('ambiguous', 1), maxStrokeDelta: 0 })).toBe(false);
    });

    it('lets the partner decide an ambiguous cell, tier 1', () => {
      expect(decideCell('还', { google: g('还'), partner: pa(true), device: null }, mode('ambiguous', 1)))
        .toEqual({ result: 'pass', tier: 1, read: '还', sources: ['google', 'strokes', 'go:grok-4.6'], confusion: null });
      expect(decideCell('还', { google: g('还'), partner: pa(false), device: null }, mode('ambiguous', -1)))
        .toMatchObject({ result: 'fail', tier: 1, sources: ['google', 'strokes', 'go:grok-4.6'] });
    });

    it('falls back to Google and the gate, degraded, when the needed partner is unavailable', () => {
      expect(decideCell('还', { google: g('还'), partner: null, device: null }, mode('ambiguous', 1)))
        .toEqual({ result: 'pass', tier: 2, read: '还', sources: ['google', 'strokes'], confusion: null });
    });

    it('is tier 1, not degraded, when the partner was not needed', () => {
      expect(decideCell('还', { google: g('还'), partner: null, device: null }, mode('ambiguous', 0)))
        .toMatchObject({ result: 'pass', tier: 1 });
      expect(decideCell('百', { google: g('白'), partner: null, device: null }, mode('ambiguous', null)))
        .toMatchObject({ result: 'fail', tier: 1, sources: ['google'] });
    });
  });

  describe('always', () => {
    it('asks as it always did', () => {
      expect(partnerNeeded('还', g('还'), mode('always', 0))).toBe(true);
      expect(partnerNeeded('还', null, mode('always', null))).toBe(true);
      expect(partnerNeeded('持', g('待'), mode('always', null))).toBe(true);
    });

    it('does not ask about a pass the stroke gate fails anyway', () => {
      expect(partnerNeeded('还', g('还'), mode('always', 3))).toBe(false);
      expect(partnerNeeded('还', g('还'), mode('always', -2))).toBe(false);
    });

    it('is tier 2 without the partner, as before', () => {
      expect(decideCell('还', { google: g('还'), partner: null, device: null }, mode('always', 0)))
        .toMatchObject({ result: 'pass', tier: 2 });
    });
  });
});

describe('decideCell — confusion with the stroke count as the second witness', () => {
  // 待 has 9 strokes; written as 持's row, the count says whether 待 is plausibly what was written.
  const strokesOnly = (readDelta: number | null, partnerMode: 'off' | 'ambiguous' = 'off') =>
    ({ ...on, partnerMode, readDelta });

  it('names the written character when it is eligible and the count fits it', () => {
    for (const d of [-1, 0, 1]) {
      expect(decideCell('持', { google: g('待'), partner: 'not-needed', device: null }, strokesOnly(d)))
        .toEqual({ result: 'fail', tier: 1, read: '待', sources: ['google', 'strokes'], confusion: '待' });
    }
    expect(decideCell('持', { google: g('待'), partner: 'not-needed', device: null }, strokesOnly(0, 'ambiguous'))!.confusion)
      .toBe('待');
  });

  it('names nothing when the count does not fit the written character', () => {
    expect(decideCell('持', { google: g('待'), partner: 'not-needed', device: null }, strokesOnly(2)))
      .toEqual({ result: 'fail', tier: 1, read: '待', sources: ['google'], confusion: null });
  });

  it('names nothing with no count, outside the pool, or before the rule starts', () => {
    expect(decideCell('持', { google: g('待'), partner: 'not-needed', device: null }, strokesOnly(null))!.confusion).toBeNull();
    expect(decideCell('续', { google: g('纟'), partner: 'not-needed', device: null }, strokesOnly(0))!.confusion).toBeNull();
    expect(decideCell('持', { google: g('待'), partner: 'not-needed', device: null }, { ...strokesOnly(0), confusion: false })!.confusion)
      .toBeNull();
  });
});

describe('partnerNeeded', () => {
  it('asks the partner when Google says pass', () => {
    expect(partnerNeeded('还', g('还'), off)).toBe(true);
  });
  it('asks the partner when Google is unavailable', () => {
    expect(partnerNeeded('还', null, off)).toBe(true);
  });
  it('asks the partner when Google reads an eligible other character and confusion is on', () => {
    expect(partnerNeeded('持', g('待'), on)).toBe(true);
  });
  it('skips the partner for a plain fail', () => {
    expect(partnerNeeded('百', g('白'), on)).toBe(false);
    expect(partnerNeeded('持', g('待'), off)).toBe(false);
  });
});

describe('mergeDay — one verdict per character per date, a fail wins', () => {
  const pass = (char: string): Review => ({ date: '2026-10-02', char, result: 'pass', evidence: 'recognition' });
  const confusion = (char: string, asked: string): Review =>
    ({ date: '2026-10-02', char, result: 'fail', evidence: 'confusion', read: char, asked });

  it('keeps the confusion fail over the same character\'s own pass', () => {
    expect(mergeDay([pass('准'), pass('难'), confusion('准', '难')])).toEqual([
      confusion('准', '难'),
      pass('难'),
    ]);
  });

  it('keeps an own-row fail over a confusion fail for the same character', () => {
    const own: Review = { date: '2026-10-02', char: '准', result: 'fail', evidence: 'recognition', read: '难' };
    expect(mergeDay([own, confusion('准', '谁')])).toEqual([own]);
  });

  it('leaves distinct characters alone and keeps first-seen order', () => {
    expect(mergeDay([pass('a'), pass('b')])).toEqual([pass('a'), pass('b')]);
  });
});

describe('an unknown partner mode', () => {
  // The config loader normalises one to 'off'; the policy must not read it as 'always'
  // either, in case one ever reaches it some other way.
  const unknown = { ...on, partnerMode: 'sometimes' as unknown as 'off', strokeDelta: 0 };

  it('never asks the partner about a Google reading, like off', () => {
    expect(partnerNeeded('还', g('还'), unknown)).toBe(false);
    expect(partnerNeeded('持', g('待'), unknown)).toBe(false);
    expect(decideCell('还', { google: g('还'), partner: null, device: null }, unknown))
      .toMatchObject({ result: 'pass', tier: 1 });
  });
});
