import { describe, expect, it, vi } from 'vitest';
import { backupFromEnv, DEFAULT_BACKUP_URL } from './backup.js';

const ok = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

describe('backupFromEnv', () => {
  it('posts to the default URL when nothing is set', async () => {
    const fetchFn = ok();
    await backupFromEnv({}, fetchFn as unknown as typeof fetch)();
    expect(fetchFn).toHaveBeenCalledWith(DEFAULT_BACKUP_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('posts to XIEHANZI_ANKI_BACKUP_URL when set', async () => {
    const fetchFn = ok();
    await backupFromEnv({ XIEHANZI_ANKI_BACKUP_URL: 'http://127.0.0.1:9/snap' }, fetchFn as unknown as typeof fetch)();
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:9/snap', expect.anything());
  });

  it('still rejects when the service is unreachable, so learn stays a hard stop', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(backupFromEnv({}, fetchFn as unknown as typeof fetch)()).rejects.toThrow(/Could not reach/);
  });

  it('skips with a warning, and without any request, only for XIEHANZI_ANKI_BACKUP=off', async () => {
    const fetchFn = ok();
    const warn = vi.fn();
    await expect(backupFromEnv({ XIEHANZI_ANKI_BACKUP: 'off' }, fetchFn as unknown as typeof fetch, warn)()).resolves.toEqual({ skipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT backed up'));
  });

  it('treats any other value as on', async () => {
    const fetchFn = ok();
    await backupFromEnv({ XIEHANZI_ANKI_BACKUP: 'false' }, fetchFn as unknown as typeof fetch)();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
