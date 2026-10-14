/**
 * What every recogniser shares. A recogniser never throws and never fails loudly: anything
 * that goes wrong — timeout, 429, malformed reply — comes back as `null`, "unavailable",
 * and the verdict policy falls to the next tier. Grading always finishes.
 */

import type { Cell } from '../cells.js';
import type { Reading } from '../verdict.js';

/**
 * `target` is the character the cell was asked for. Only a comparing recogniser uses it;
 * one that reads blind (Google) ignores it.
 */
export type Recogniser = { name: string; recognise(cell: Cell, target: string): Promise<Reading | null> };
export type Recognisers = { google: Recogniser | null; partner: Recogniser | null };

/** POSTs JSON; the parsed reply, or null for any failure. */
export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Runs `attempt` up to `retries + 1` times, stopping at the first non-null result. */
export async function withRetries<T>(retries: number, attempt: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i <= retries; i += 1) {
    const result = await attempt();
    if (result !== null) return result;
  }
  return null;
}

/** Single Han characters only, in order: drops completions like 和口 and noise like 'i' or '#'. */
export function hanOnly(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is string => typeof c === 'string' && [...c].length === 1 && /\p{Script=Han}/u.test(c),
  );
}
