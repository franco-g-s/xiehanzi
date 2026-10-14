import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession, saveSession, clearSession } from './session.js';

let path: string;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'xiehanzi-session-')), 'session.json');
});

describe('session storage', () => {
  it('round-trips a token', () => {
    saveSession(path, { token: 'T1', account: 'a@b.c', savedAt: '2026-08-20' });
    expect(loadSession(path)!.token).toBe('T1');
  });

  it('is owner-readable only — the token is as good as the password', () => {
    saveSession(path, { token: 'T1', account: 'a@b.c', savedAt: '2026-08-20' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('returns null when there is no session yet', () => {
    expect(loadSession(path)).toBeNull();
  });

  it('returns null rather than throwing on a corrupt file', () => {
    writeFileSync(path, 'not json');
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the token is empty', () => {
    writeFileSync(path, JSON.stringify({ token: '' }));
    expect(loadSession(path)).toBeNull();
  });

  it('never stores a password, only the issued token', () => {
    saveSession(path, { token: 'T1', account: 'a@b.c', savedAt: '2026-08-20' });
    const raw = JSON.stringify(loadSession(path));
    expect(raw).not.toMatch(/password/i);
  });

  it('clears cleanly, and clearing twice is not an error', () => {
    saveSession(path, { token: 'T1', account: 'a@b.c', savedAt: '2026-08-20' });
    clearSession(path);
    clearSession(path);
    expect(existsSync(path)).toBe(false);
  });
});
