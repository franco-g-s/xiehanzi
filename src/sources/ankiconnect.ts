/**
 * AnkiConnect HTTP client.
 *
 * This is the ONLY path by which anything in this project touches the Anki collection.
 * The collection file is never opened for writing — see the design spec.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AnkiClientConfig = {
  /** e.g. http://127.0.0.1:8765 */
  host: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
};

/** AnkiConnect reported a problem, or replied with something we can't trust. */
export class AnkiConnectError extends Error {
  override name = 'AnkiConnectError';
}

/**
 * The host didn't answer at all. Almost always means Anki isn't running — worth its own
 * type so callers can say something useful instead of surfacing "fetch failed".
 */
export class AnkiUnreachableError extends AnkiConnectError {
  override name = 'AnkiUnreachableError';
}

/** AnkiConnect always replies with exactly these two keys. */
type AnkiResponse<T> = { result: T; error: string | null };

function isAnkiResponse(value: unknown): value is AnkiResponse<unknown> {
  return (
    typeof value === 'object' && value !== null && 'result' in value && 'error' in value
  );
}

export type AnkiClient = {
  invoke<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
  deckNames(): Promise<string[]>;
  modelNames(): Promise<string[]>;
  findNotes(query: string): Promise<number[]>;
  findCards(query: string): Promise<number[]>;
};

export function createAnkiClient(config: AnkiClientConfig): AnkiClient {
  const { host, fetchFn = fetch, timeoutMs = 15_000 } = config;

  async function invoke<T = unknown>(
    action: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    // AnkiConnect rejects a `params` key that is present but empty, so omit it entirely.
    const body = JSON.stringify(params === undefined ? { action, version: 6 } : { action, version: 6, params });

    let response: Response;
    try {
      response = await fetchFn(host, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new AnkiUnreachableError(
        `Could not reach Anki at ${host} (action "${action}"). Is Anki running with the AnkiConnect add-on enabled?`,
        { cause },
      );
    }

    if (!response.ok) {
      throw new AnkiConnectError(
        `Anki returned HTTP ${response.status} for action "${action}".`,
      );
    }

    const payload: unknown = await response.json();
    if (!isAnkiResponse(payload)) {
      throw new AnkiConnectError(
        `Malformed AnkiConnect response for action "${action}": expected result and error keys.`,
      );
    }

    // Failure is signalled in the body with HTTP 200 — checking status alone is not enough.
    if (payload.error !== null) {
      throw new AnkiConnectError(`Anki rejected action "${action}": ${payload.error}`);
    }

    return payload.result as T;
  }

  return {
    invoke,
    deckNames: () => invoke<string[]>('deckNames'),
    modelNames: () => invoke<string[]>('modelNames'),
    findNotes: (query) => invoke<number[]>('findNotes', { query }),
    findCards: (query) => invoke<number[]>('findCards', { query }),
  };
}
