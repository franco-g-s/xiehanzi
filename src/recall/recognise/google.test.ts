import { describe, it, expect, vi } from 'vitest';
import { createGoogleRecogniser } from './google.js';
import type { Cell } from '../cells.js';

const cell: Cell = { strokes: [[{ x: 1, y: 1 }, { x: 5, y: 5 }]], png: Buffer.alloc(0), cellMm: 12.5 };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('google recogniser', () => {
  it('returns single-character Han candidates in rank order', async () => {
    const fetch = vi.fn(async () => ok(['SUCCESS', [['', ['还', '還', '还是', 'i', '这']]]]));
    const r = await createGoogleRecogniser({ fetch }).recognise(cell, '还');
    expect(r).toEqual({ source: 'google', candidates: ['还', '還', '这'] });
  });

  it('sends the strokes scaled to a writing area the size of the cell', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok(['SUCCESS', [['', ['一']]]]));
    await createGoogleRecogniser({ fetch }).recognise(cell, '还');
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.requests[0].writing_guide).toEqual({ writing_area_width: 250, writing_area_height: 250 });
    expect(body.requests[0].ink).toEqual([[[20, 100], [20, 100], []]]);
    expect(body.requests[0].language).toBe('zh_CN');
  });

  it('is unavailable for a cell with no strokes, without calling out', async () => {
    const fetch = vi.fn();
    expect(await createGoogleRecogniser({ fetch }).recognise({ ...cell, strokes: [] }, '还')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is unavailable, not wrong, when the endpoint fails, after one retry', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    expect(await createGoogleRecogniser({ fetch, retries: 1 }).recognise(cell, '还')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('is unavailable when the endpoint answers with no candidates', async () => {
    const fetch = vi.fn(async () => ok(['SUCCESS', [['', []]]]));
    expect(await createGoogleRecogniser({ fetch }).recognise(cell, '还')).toBeNull();
  });

  it('is unavailable when fetch throws', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('network down'); });
    expect(await createGoogleRecogniser({ fetch, retries: 0 }).recognise(cell, '还')).toBeNull();
  });
});
