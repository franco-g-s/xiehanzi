/**
 * A vision model on Franco's OpenCode Go subscription, comparing the picture of the cell
 * with the target character printed in 楷书 beside it.
 *
 * It is the strictness check on Google: Google snaps a malformed character to the nearest
 * real one, and a model looking at the picture catches those. grok-4.6 was the best
 * partner on the 2026-09-30 benchmark; the model is a config value.
 *
 * The partner is told the target and shown it rendered, and asked "is this that
 * character, written correctly?", with explicit tolerance for normal handwriting
 * variation. On the 2026-10-01 prompt test over the 101 labelled cells this vetoed 2 of
 * 53 correct cells and caught all 6 malformed ones (3 pipeline errors, against 4 for the
 * old blind prompt and 14 for a reference without the tolerance). Showing the target
 * could bias the model into "correcting" a confusion into the answer; the check is 20
 * decoys — a correct character re-asked as a look-alike target — of which it accepted 1.
 *
 * Go asks third-party clients for a stable session id and their own user agent, and caps
 * each model per 5 hours; a night's ~10 calls is a tiny share of that.
 */

import { hanOnly, postJson, withRetries, type Recogniser } from './http.js';
import { referencePng, referenceStrokeCount } from './reference.js';
import type { Reading } from '../verdict.js';

export type GoConfig = { model: string; api: 'chat' | 'messages' | 'responses'; timeoutMs: number; retries: number };

export const GO_BASE = 'https://opencode.ai/zen/go/v1';

// The prompt texts exactly as tested on 2026-10-01 (prompt A′), example characters and
// all: changing a word here means re-running that test.
const CORE = `You are checking a Chinese learner's handwriting test. The learner wrote one simplified character from memory, in a square grid cell, with a stylus.

Learners' typical errors — any of these means the character is NOT correct:
- a different real character that sounds or looks alike: 知/识, 做/作, 待/持, 准/难/谁, 脸/险, 的/得, 再/在, 每/没, 城/成
- a wrong component: 样 written with 禾 instead of 木
- missing strokes or components: 道 without the two dots and line on top
- extra strokes: 里 with the vertical stroke poking through the top of 日
- something that is not a real character at all

First describe what is actually drawn: each component, left→right and top→bottom. Then decide. Judge only what is on the page; never guess what the learner meant.`;
const TOLERANCE = `Handwriting is never identical to print. These are NORMAL and must not make a character incorrect: different proportions or slant, wavy or uneven lines, strokes of different length, strokes joined together in one movement (e.g. the two lines of 二 run together, 辶 written in one sweep), quick ticks for dots, loose or open loops (e.g. 幺), components slightly overlapping or spaced apart, and non-standard stroke order.
Judge only two things: is every component the right one, and is no stroke missing or added? Before you answer "malformed" or "incomplete", you must name the concrete component or stroke that is wrong, missing or extra (for example "木 written as 禾: extra top stroke", "道 missing 丷 above 首"). If you cannot name one, the character is "correct".`;
const SCHEMA = `"observed": "...", "verdict": "correct" | "different_character" | "malformed" | "incomplete" | "illegible", "written": "<the real character actually written, or null if it is not one>", "closest": ["...", "...", "..."]`;
const SCHEMA2 = SCHEMA + `, "error": "<the concrete wrong, missing or extra component/stroke, or null>"`;

/**
 * `writtenStrokes` 0 means no strokes could be read for the cell (an old layout, a parse
 * failure), not that none were written: the image has ink. A "0 against 9" hint would
 * push the model toward "incomplete" on a correct character, so the sentence is dropped.
 */
export function comparePrompt(target: string, writtenStrokes: number, referenceStrokes: number): string {
  const hint = writtenStrokes === 0
    ? ''
    : ` The learner made ${writtenStrokes} pen strokes; the reference has ${referenceStrokes} (a hint only: fluent writers often join strokes).`;
  return `${CORE}\n\n${TOLERANCE}\n\nImage 1 is the learner's handwriting. Image 2 is the target character ${target}, printed in 楷书 for reference.${hint}\n\nIs image 1 the character in image 2, written correctly? Compare them component by component.\n\nReply with JSON only: {${SCHEMA2}}`;
}

const HEADERS = { 'user-agent': 'xiehanzi-grader/1.0', 'x-opencode-session': 'xiehanzi-grader' };
const MAX_TOKENS = 12_000;

/** One user turn: the handwriting, then the reference, then the question — the tested order. */
function request(
  cfg: GoConfig,
  key: string,
  images: { handwriting: string; reference: string },
  text: string,
): { url: string; headers: Record<string, string>; body: unknown } {
  const both = [images.handwriting, images.reference];
  const dataUrl = (b64: string) => `data:image/png;base64,${b64}`;
  switch (cfg.api) {
    case 'chat':
      return {
        url: `${GO_BASE}/chat/completions`,
        headers: { ...HEADERS, authorization: `Bearer ${key}` },
        body: {
          model: cfg.model, reasoning_effort: 'low', max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: [
            ...both.map((b64) => ({ type: 'image_url', image_url: { url: dataUrl(b64) } })),
            { type: 'text', text },
          ] }],
        },
      };
    case 'messages':
      return {
        url: `${GO_BASE}/messages`,
        headers: { ...HEADERS, authorization: `Bearer ${key}`, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: {
          model: cfg.model, max_tokens: MAX_TOKENS,
          messages: [{ role: 'user', content: [
            ...both.map((b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } })),
            { type: 'text', text },
          ] }],
        },
      };
    case 'responses':
      return {
        url: `${GO_BASE}/responses`,
        headers: { ...HEADERS, authorization: `Bearer ${key}` },
        body: {
          model: cfg.model, reasoning: { effort: 'low' }, max_output_tokens: MAX_TOKENS,
          input: [{ role: 'user', content: [
            ...both.map((b64) => ({ type: 'input_image', image_url: dataUrl(b64) })),
            { type: 'input_text', text },
          ] }],
        },
      };
  }
}

type Reply = {
  choices?: { message?: { content?: string } }[];
  content?: { type?: string; text?: string }[];
  output_text?: string;
  output?: { content?: { type?: string; text?: string }[] }[];
};

function replyText(api: GoConfig['api'], reply: Reply): string {
  if (api === 'chat') return reply.choices?.[0]?.message?.content ?? '';
  if (api === 'messages') return (reply.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  return reply.output_text ??
    (reply.output ?? []).flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
}

const VERDICTS = new Set(['correct', 'different_character', 'malformed', 'incomplete', 'illegible']);

/**
 * The reply as a reading of the target, or null when it does not say. The candidates name
 * what was written, for the confusion rule. A rejected target is dropped from them, so a
 * rejection can never pass through a top-3 reading; an accepted one leads them.
 */
function readingIn(text: string, target: string, source: string): Reading | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json === undefined) return null;
  let reply: { verdict?: unknown; written?: unknown; closest?: unknown };
  try {
    reply = JSON.parse(json) as typeof reply;
  } catch {
    return null;
  }
  if (typeof reply.verdict !== 'string' || !VERDICTS.has(reply.verdict)) return null;
  const accepts = reply.verdict === 'correct';
  const closest = Array.isArray(reply.closest) ? reply.closest : [];
  const read = [...new Set(hanOnly([reply.written, ...closest]))].filter((c) => c !== target);
  return { source, candidates: accepts ? [target, ...read] : read, accepts };
}

export function createGoRecogniser(cfg: GoConfig, key: string, opts: { fetch?: typeof fetch } = {}): Recogniser {
  const fetchImpl = opts.fetch ?? fetch;
  const source = `go:${cfg.model}`;
  return {
    name: source,
    async recognise(cell, target) {
      // No reference to show, no comparison: unavailable, and grading falls back to Google.
      const reference = referencePng(target);
      const referenceStrokes = referenceStrokeCount(target);
      if (reference === null || referenceStrokes === null) return null;

      const { url, headers, body } = request(
        cfg,
        key,
        { handwriting: cell.png.toString('base64'), reference: reference.toString('base64') },
        comparePrompt(target, cell.strokes.length, referenceStrokes),
      );
      return withRetries(cfg.retries, async () => {
        const reply = await postJson(fetchImpl, url, headers, body, cfg.timeoutMs);
        return reply === null ? null : readingIn(replyText(cfg.api, reply as Reply), target, source);
      });
    },
  };
}
