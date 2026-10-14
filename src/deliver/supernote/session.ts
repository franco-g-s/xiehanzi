/**
 * Stores the Supernote Cloud session token between runs.
 *
 * Two-factor means logging in needs a code from the account holder's inbox, which a
 * scheduled job cannot supply. The token from an interactive `xiehanzi login` is kept here
 * so unattended pushes work until it expires.
 *
 * Never holds the password — only the issued token.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';

export type Session = {
  token: string;
  account: string;
  savedAt: string;
};

export function loadSession(path: string): Session | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Session;
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(path: string, session: Session): void {
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  // Owner-only: this token is as good as the password for reading the drive.
  chmodSync(path, 0o600);
}

export function clearSession(path: string): void {
  if (existsSync(path)) rmSync(path);
}
