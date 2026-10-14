/**
 * Triggers a local backup service that snapshots the Anki collection before any write.
 * The service takes a POST and answers once the snapshot is safe; what it does inside
 * (sync, export, copy, commit) is its own business.
 *
 * Must reject if the backup did not happen: `learn` treats that as a hard stop.
 *
 * Configured from the environment, so the default stays strict:
 *   XIEHANZI_ANKI_BACKUP_URL  where to POST (default below)
 *   XIEHANZI_ANKI_BACKUP=off  skip the backup, with a warning, for a setup that has no
 *                             such service. Anything else, or unset, means back up.
 */

export const DEFAULT_BACKUP_URL = 'http://127.0.0.1:18766/backup';

export function createBackup(
  url: string = DEFAULT_BACKUP_URL,
  fetchFn: typeof fetch = fetch,
): () => Promise<unknown> {
  return async () => {
    let response: Response;
    try {
      // The service may sync and commit before answering, so it is not fast.
      response = await fetchFn(url, { method: 'POST', signal: AbortSignal.timeout(180_000) });
    } catch (cause) {
      throw new Error(`Could not reach the Anki backup service at ${url}.`, { cause });
    }
    if (!response.ok) throw new Error(`Anki backup service returned HTTP ${response.status}.`);
    return response.json();
  };
}

/** The backup step `learn` runs, chosen from the environment. */
export function backupFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  warn: (message: string) => void = (m) => console.warn(m),
): () => Promise<unknown> {
  if (env.XIEHANZI_ANKI_BACKUP === 'off') {
    return async () => {
      warn('warning: XIEHANZI_ANKI_BACKUP=off, so the Anki collection was NOT backed up before this write.');
      return { skipped: true };
    };
  }
  return createBackup(env.XIEHANZI_ANKI_BACKUP_URL || DEFAULT_BACKUP_URL, fetchFn);
}
