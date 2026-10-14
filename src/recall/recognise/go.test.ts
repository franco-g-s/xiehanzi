import { describe, it, expect, vi } from 'vitest';
import { createGoRecogniser, comparePrompt, type GoConfig } from './go.js';
import { referencePng } from './reference.js';
import type { Cell } from '../cells.js';

const point = { x: 0, y: 0 };
/** Seven pen strokes, against 9 in the 待 reference. */
const cell: Cell = { strokes: Array.from({ length: 7 }, () => [point]), png: Buffer.from([1, 2, 3]), cellMm: 12.5 };
const cfg = (api: GoConfig['api']): GoConfig => ({ model: 'm', api, timeoutMs: 1000, retries: 0 });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const chatReply = (reply: unknown) =>
  vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
    ok({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }));
const verdict = (v: string, written: string | null, closest: string[] = []) =>
  ({ observed: '…', verdict: v, written, closest, error: null });

const handwriting = 'data:image/png;base64,AQID';
const reference = `data:image/png;base64,${referencePng('待')!.toString('base64')}`;

describe('comparePrompt', () => {
  it('names the target and both stroke counts, and asks for the comparison', () => {
    const text = comparePrompt('待', 7, 9);
    expect(text).toContain('Image 2 is the target character 待, printed in 楷书 for reference.');
    expect(text).toContain('The learner made 7 pen strokes; the reference has 9');
    expect(text).toContain('Is image 1 the character in image 2, written correctly?');
    expect(text).toContain('"error": "<the concrete wrong, missing or extra component/stroke, or null>"');
  });

  // No parseable strokes (an old layout, a parse failure) is not "0 strokes written": a
  // 0-against-9 hint would push the model toward "incomplete" on a correct character.
  const hint = ' The learner made 7 pen strokes; the reference has 9 (a hint only: fluent writers often join strokes).';

  it('keeps the stroke-count sentence, exactly as tested, when strokes were read', () => {
    expect(comparePrompt('待', 7, 9)).toContain(`printed in 楷书 for reference.${hint}\n\nIs image 1`);
  });

  it('drops only the stroke-count sentence when no strokes were read', () => {
    const text = comparePrompt('待', 0, 9);
    expect(text).not.toMatch(/pen strokes|a hint only/);
    expect(text).toBe(comparePrompt('待', 7, 9).replace(hint, ''));
  });
});

describe('go recogniser — request', () => {
  it('responses API: handwriting then reference, then the prompt; keeps headers and effort', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      ok({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(verdict('correct', '待')) }] }] }));
    expect(await createGoRecogniser(cfg('responses'), 'k', { fetch }).recognise(cell, '待'))
      .toEqual({ source: 'go:m', candidates: ['待'], accepts: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://opencode.ai/zen/go/v1/responses');
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['x-opencode-session']).toBe('xiehanzi-grader');
    expect(headers['user-agent']).toBe('xiehanzi-grader/1.0');
    const body = JSON.parse(String(init!.body));
    expect(body.input[0].content).toEqual([
      { type: 'input_image', image_url: handwriting },
      { type: 'input_image', image_url: reference },
      { type: 'input_text', text: comparePrompt('待', 7, 9) },
    ]);
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('chat API: two image_url parts in order, then the prompt; tolerates a fenced reply', async () => {
    const fetch = chatReply('```json\n' + JSON.stringify(verdict('correct', '待')) + '\n```');
    expect(await createGoRecogniser(cfg('chat'), 'k', { fetch }).recognise(cell, '待'))
      .toEqual({ source: 'go:m', candidates: ['待'], accepts: true });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.reasoning_effort).toBe('low');
    expect(body.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: handwriting } },
      { type: 'image_url', image_url: { url: reference } },
      { type: 'text', text: comparePrompt('待', 7, 9) },
    ]);
  });

  it('messages API: two base64 image blocks in order, then the prompt', async () => {
    const fetch = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      ok({ content: [{ type: 'text', text: JSON.stringify(verdict('correct', '待')) }] }));
    expect(await createGoRecogniser(cfg('messages'), 'k', { fetch }).recognise(cell, '待'))
      .toEqual({ source: 'go:m', candidates: ['待'], accepts: true });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: referencePng('待')!.toString('base64') } },
      { type: 'text', text: comparePrompt('待', 7, 9) },
    ]);
  });
});

describe('go recogniser — verdicts', () => {
  const ask = async (reply: unknown, target: string) =>
    createGoRecogniser(cfg('chat'), 'k', { fetch: chatReply(reply) }).recognise(cell, target);

  it('correct: accepts, with the target first', async () => {
    expect(await ask(verdict('correct', '侍', ['待', '持']), '待'))
      .toEqual({ source: 'go:m', candidates: ['待', '侍', '持'], accepts: true });
  });

  it('malformed with no real character written: a rejection, without the target', async () => {
    expect(await ask(verdict('malformed', null, ['样']), '样'))
      .toEqual({ source: 'go:m', candidates: [], accepts: false });
    expect(await ask(verdict('malformed', null, ['样', '洋']), '样'))
      .toEqual({ source: 'go:m', candidates: ['洋'], accepts: false });
  });

  it('different character: a rejection naming what was written first', async () => {
    expect(await ask(verdict('different_character', '待', ['持', '侍']), '持'))
      .toEqual({ source: 'go:m', candidates: ['待', '侍'], accepts: false });
  });

  it('is unavailable on an unknown or missing verdict, bad JSON, or a usage-limit 429', async () => {
    expect(await ask(verdict('probably', '待'), '待')).toBeNull();
    expect(await ask({ written: '待' }, '待')).toBeNull();
    expect(await ask('I think it is 待', '待')).toBeNull();
    expect(await ask('{"verdict": "correct",', '待')).toBeNull();
    const fetch = vi.fn(async () => new Response('{"error":{"type":"GoUsageLimitError"}}', { status: 429 }));
    expect(await createGoRecogniser(cfg('chat'), 'k', { fetch }).recognise(cell, '待')).toBeNull();
  });

  it('is unavailable, without calling out, for a character with no reference', async () => {
    const fetch = chatReply(verdict('correct', '㐀'));
    expect(await createGoRecogniser(cfg('chat'), 'k', { fetch }).recognise(cell, '㐀')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
