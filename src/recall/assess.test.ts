import { describe, it, expect, vi } from 'vitest';
import { assessPage } from './assess.js';
import { cellRect } from './grade.js';
import { encodeRle, RLE } from '../deliver/note/rle.js';
import type { Recogniser } from './recognise/http.js';
import type { Reading } from './verdict.js';
import type { RecallGeometry, RecallRow } from '../state/sheets.js';
import type { ParsedPage } from '../deliver/note/read.js';
import type { Stroke } from '../deliver/note/strokes.js';

const geometry: RecallGeometry = {
  cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11,
};
const W_MM = 162.6, H_MM = 216.7, PX_W = 1920, PX_H = 2560;

function writing(cells: [row: number, cell: number][]): Buffer {
  const px = new Uint8Array(PX_W * PX_H).fill(RLE.background);
  for (const [row, cell] of cells) {
    const r = cellRect(geometry, row, cell);
    const x0 = Math.round((r.xMm / W_MM) * PX_W), x1 = Math.round(((r.xMm + r.widthMm) / W_MM) * PX_W);
    const y0 = Math.round((r.yMm / H_MM) * PX_H), y1 = Math.round(((r.yMm + r.heightMm) / H_MM) * PX_H);
    for (let y = y0; y < y1; y += 1) px.fill(RLE.black, y * PX_W + x0, y * PX_W + x1);
  }
  return encodeRle(px);
}

const rows = (chars: string[]): RecallRow[] => chars.map((char, row) => ({ char, cue: '…', page: 0, row }));

/** A recogniser answering per row, in call order. `null` entries mean unavailable. */
function scripted(name: string, answers: (string[] | null)[]): Recogniser & { recognise: ReturnType<typeof vi.fn> } {
  let i = 0;
  return {
    name,
    recognise: vi.fn(async (): Promise<Reading | null> => {
      const a = answers[i++];
      return a === null || a === undefined ? null : { source: name, candidates: a };
    }),
  };
}

const base = (page: ParsedPage, chars: string[]) => ({
  page, rows: rows(chars), geometry, date: '2026-10-02', pageWidthMm: W_MM, pageHeightMm: H_MM,
  eligible: new Set(['持', '待']), confusion: true, partnerMode: 'always' as const, maxStrokeDelta: 1,
});

/** `n` short pen strokes in the middle of row 0's graded cell, in page pixels. */
function strokesInRow0(n: number): Stroke[] {
  const r = cellRect(geometry, 0, 0);
  const cx = ((r.xMm + r.widthMm / 2) / W_MM) * PX_W, cy = ((r.yMm + r.heightMm / 2) / H_MM) * PX_H;
  return Array.from({ length: n }, (_, i) => [{ x: cx - 20, y: cy + i }, { x: cx + 20, y: cy + i }]);
}

describe('assessPage', () => {
  it('passes on Google + partner agreement and records both as sources', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const out = await assessPage({ ...base(page, ['还']), recognisers: {
      google: scripted('google', [['还']]), partner: scripted('go:grok-4.6', [['还']]),
    } });
    expect(out.reviews).toEqual([
      { date: '2026-10-02', char: '还', result: 'pass', evidence: 'recognition', read: '还', sources: ['google', 'go:grok-4.6'] },
    ]);
    expect(out.tiers[1]).toBe(1);
  });

  it('tells both recognisers which character the row asked for', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const google = scripted('google', [['还']]);
    const partner = scripted('go:grok-4.6', [['还']]);
    await assessPage({ ...base(page, ['还']), recognisers: { google, partner } });
    expect(google.recognise).toHaveBeenCalledWith(expect.anything(), '还');
    expect(partner.recognise).toHaveBeenCalledWith(expect.anything(), '还');
  });

  it('fails on a partner rejection that names no character, rather than leaving it ungraded', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const partner = { name: 'go:grok-4.6', recognise: vi.fn(async () => ({ source: 'go:grok-4.6', candidates: [], accepts: false })) };
    const out = await assessPage({ ...base(page, ['样']), recognisers: { google: scripted('google', [['样']]), partner } });
    expect(out.reviews).toEqual([
      { date: '2026-10-02', char: '样', result: 'fail', evidence: 'recognition', read: '样', sources: ['google', 'go:grok-4.6'] },
    ]);
    expect(out.ungraded).toBe(0);
  });

  it('records a confusion fail for the character written instead', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const out = await assessPage({ ...base(page, ['持']), recognisers: {
      google: scripted('google', [['待']]), partner: scripted('go:grok-4.6', [['待']]),
    } });
    expect(out.reviews.map((r) => [r.char, r.result, r.evidence, r.asked])).toEqual([
      ['持', 'fail', 'recognition', undefined],
      ['待', 'fail', 'confusion', '持'],
    ]);
  });

  it('does not ask the partner for a plain fail', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const partner = scripted('go:grok-4.6', []);
    await assessPage({ ...base(page, ['百']), recognisers: { google: scripted('google', [['白']]), partner } });
    expect(partner.recognise).not.toHaveBeenCalled();
  });

  it('marks a verdict degraded when the partner is missing', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const out = await assessPage({ ...base(page, ['还']), recognisers: { google: scripted('google', [['还']]), partner: null } });
    expect(out.reviews[0]).toMatchObject({ result: 'pass', degraded: true });
    expect(out.tiers[2]).toBe(1);
  });

  it('falls back to the device transcription, recorded as transcription evidence', async () => {
    const page: ParsedPage = {
      recognition: [{ label: '真', x: geometry.originXMm + 2, y: geometry.originYMm + 2, width: 8, height: 8 }],
      writing: writing([[0, 0]]),
    };
    const out = await assessPage({ ...base(page, ['真']), recognisers: { google: null, partner: null } });
    expect(out.reviews[0]).toMatchObject({ char: '真', result: 'pass', evidence: 'transcription', degraded: true });
  });

  it('leaves a written cell ungraded, never passed, when nothing can read it', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const out = await assessPage({ ...base(page, ['还']), recognisers: { google: null, partner: null } });
    expect(out.reviews).toEqual([]);
    expect(out.ungraded).toBe(1);
    expect(out.ungradedChars).toEqual(['还']);
  });

  it('fails a blank graded cell when the rest of its row has ink, without asking anyone', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 2]]) };
    const google = scripted('google', []);
    const out = await assessPage({ ...base(page, ['市']), recognisers: { google, partner: null } });
    expect(out.reviews).toEqual([{ date: '2026-10-02', char: '市', result: 'fail', evidence: 'ink' }]);
    expect(google.recognise).not.toHaveBeenCalled();
  });

  it('records nothing for a row with no ink at all', async () => {
    const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
    const out = await assessPage({ ...base(page, ['还', '真']), recognisers: {
      google: scripted('google', [['还']]), partner: scripted('go:grok-4.6', [['还']]),
    } });
    expect(out.reviews.map((r) => r.char)).toEqual(['还']);
  });

  describe('the stroke gate and partner modes', () => {
    it('with the partner off, never asks it and records Google\'s pass as not degraded', async () => {
      const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
      const partner = scripted('go:grok-4.6', [['还']]);
      const out = await assessPage({ ...base(page, ['还']), partnerMode: 'off', recognisers: { google: scripted('google', [['还']]), partner } });
      expect(partner.recognise).not.toHaveBeenCalled();
      expect(out.reviews).toEqual([
        { date: '2026-10-02', char: '还', result: 'pass', evidence: 'recognition', read: '还', sources: ['google'] },
      ]);
      expect(out.tiers[1]).toBe(1);
    });

    it('is not degraded with the partner off even when it is unconfigured', async () => {
      const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]) };
      const out = await assessPage({ ...base(page, ['还']), partnerMode: 'off', recognisers: { google: scripted('google', [['还']]), partner: null } });
      expect(out.reviews[0]!.degraded).toBeUndefined();
    });

    it('counts the cell\'s strokes against the target\'s reference: 还 has 7', async () => {
      const at = async (n: number) => {
        const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]), strokes: strokesInRow0(n) };
        const out = await assessPage({ ...base(page, ['还']), partnerMode: 'off', recognisers: { google: scripted('google', [['还']]), partner: null } });
        return out.reviews[0];
      };
      expect(await at(8)).toMatchObject({ result: 'pass', sources: ['google', 'strokes'] });
      expect(await at(9)).toMatchObject({ result: 'fail', read: '还', sources: ['google', 'strokes'] });
      expect(await at(5)).toMatchObject({ result: 'fail' });
    });

    it('asks the partner, when ambiguous, only for a pass one stroke off', async () => {
      const ask = async (n: number) => {
        const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]), strokes: strokesInRow0(n) };
        const partner = { name: 'go:grok-4.6', recognise: vi.fn(async () => ({ source: 'go:grok-4.6', candidates: [], accepts: false })) };
        const out = await assessPage({ ...base(page, ['还']), partnerMode: 'ambiguous', recognisers: { google: scripted('google', [['还']]), partner } });
        return { asked: partner.recognise.mock.calls.length, review: out.reviews[0] };
      };
      expect(await ask(7)).toMatchObject({ asked: 0, review: { result: 'pass' } });
      expect(await ask(6)).toMatchObject({ asked: 1, review: { result: 'fail', sources: ['google', 'strokes', 'go:grok-4.6'] } });
    });

    it('checks a confusion against the written character\'s own count, not the target\'s', async () => {
      // One stroke under 还's row: six off 还, an exact fit for 一.
      const page: ParsedPage = { recognition: null, writing: writing([[0, 0]]), strokes: strokesInRow0(1) };
      const out = await assessPage({
        ...base(page, ['还']), partnerMode: 'off', eligible: new Set(['一']),
        recognisers: { google: scripted('google', [['一']]), partner: null },
      });
      expect(out.reviews.map((r) => [r.char, r.result, r.evidence, r.sources])).toEqual([
        ['还', 'fail', 'recognition', ['google', 'strokes']],
        ['一', 'fail', 'confusion', ['google', 'strokes']],
      ]);
    });
  });
});
