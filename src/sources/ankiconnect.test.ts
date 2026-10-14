import { describe, it, expect, vi } from 'vitest';
import { createAnkiClient, AnkiConnectError, AnkiUnreachableError } from './ankiconnect.js';
import type { FetchLike } from './ankiconnect.js';

/** Explicit params keep the mock's inferred signature compatible with FetchLike. */
const respondWith = (body: string, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }));

const ok = (result: unknown) => respondWith(JSON.stringify({ result, error: null }));

const failWith = (error: string) => respondWith(JSON.stringify({ result: null, error }));

describe('createAnkiClient', () => {
  it('posts action, version 6 and params to the configured host', async () => {
    const fetchFn = ok(['Default']);
    const anki = createAnkiClient({ host: 'http://127.0.0.1:8765', fetchFn });

    await anki.invoke('findNotes', { query: 'deck:Default' });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8765');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      action: 'findNotes',
      version: 6,
      params: { query: 'deck:Default' },
    });
  });

  it('omits params when none are given', async () => {
    const fetchFn = ok([]);
    const anki = createAnkiClient({ host: 'http://h', fetchFn });

    await anki.invoke('deckNames');

    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({ action: 'deckNames', version: 6 });
  });

  it('unwraps the result field', async () => {
    const anki = createAnkiClient({ host: 'http://h', fetchFn: ok(['a', 'b']) });
    await expect(anki.invoke('deckNames')).resolves.toEqual(['a', 'b']);
  });

  // AnkiConnect signals failure in the body with HTTP 200, so this must not be missed.
  it('throws when the body carries an error, even on HTTP 200', async () => {
    const fetchFn = failWith('deck was not found');
    const anki = createAnkiClient({ host: 'http://h', fetchFn });

    await expect(anki.invoke('findCards', { query: 'deck:nope' })).rejects.toThrow(
      AnkiConnectError,
    );
    await expect(anki.invoke('findCards')).rejects.toThrow(/deck was not found/);
  });

  it('names the action in the error so failures are traceable', async () => {
    const anki = createAnkiClient({ host: 'http://h', fetchFn: failWith('boom') });
    await expect(anki.invoke('addNote')).rejects.toThrow(/addNote/);
  });

  it('throws on a non-200 response', async () => {
    const anki = createAnkiClient({ host: 'http://h', fetchFn: respondWith('nope', 500) });
    await expect(anki.invoke('deckNames')).rejects.toThrow(/500/);
  });

  it('rejects a malformed body missing the error key', async () => {
    const fetchFn = respondWith(JSON.stringify({ result: 1 }));
    const anki = createAnkiClient({ host: 'http://h', fetchFn });
    await expect(anki.invoke('deckNames')).rejects.toThrow(AnkiConnectError);
  });

  // The overwhelmingly common failure in practice: Anki simply isn't running.
  it('reports an unreachable host as such, not as a generic fetch failure', async () => {
    const fetchFn: FetchLike = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new TypeError('fetch failed');
    });
    const anki = createAnkiClient({ host: 'http://127.0.0.1:8765', fetchFn });

    const err = await anki.invoke('deckNames').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnkiUnreachableError);
    expect((err as Error).message).toMatch(/Anki/);
    expect((err as Error).message).toMatch(/127\.0\.0\.1:8765/);
  });

  it('exposes deckNames as a typed helper', async () => {
    const anki = createAnkiClient({ host: 'http://h', fetchFn: ok(['HSK 3.0 Vocabulary']) });
    await expect(anki.deckNames()).resolves.toEqual(['HSK 3.0 Vocabulary']);
  });
});
