import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGoKey, buildRecognisers, loadRecognitionConfig } from './config.js';

describe('loadGoKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xiehanzi-key-'));
  const auth = join(dir, 'auth.json');

  it('prefers the environment', () => {
    writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-file' } }));
    expect(loadGoKey({ XIEHANZI_OPENCODE_GO_KEY: 'from-env' }, auth)).toBe('from-env');
  });

  it('falls back to opencode\'s auth file', () => {
    expect(loadGoKey({}, auth)).toBe('from-file');
  });

  it('is null, not an error, when there is no key anywhere', () => {
    expect(loadGoKey({}, join(dir, 'missing.json'))).toBeNull();
  });
});

describe('buildRecognisers', () => {
  it('has no partner without a key, so grading degrades instead of failing', () => {
    const cfg = loadRecognitionConfig(join(process.cwd(), 'config/recognition.json'));
    const r = buildRecognisers(cfg, null);
    expect(r.google).not.toBeNull();
    expect(r.partner).toBeNull();
  });

  it('reads grok-4.6 over the responses API from the committed config', () => {
    const cfg = loadRecognitionConfig(join(process.cwd(), 'config/recognition.json'));
    expect(cfg.partner).toMatchObject({ model: 'grok-4.6', api: 'responses' });
    expect(cfg.confusionFrom).toBe('2026-10-01');
  });
});

describe('loadRecognitionConfig', () => {
  it('ships with the partner off and a one-stroke limit', () => {
    const cfg = loadRecognitionConfig(join(process.cwd(), 'config/recognition.json'));
    expect(cfg.partnerMode).toBe('off');
    expect(cfg.maxStrokeDelta).toBe(1);
  });

  it('reads a config from before the stroke gate as the partner always asked, one stroke allowed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xiehanzi-cfg-'));
    const path = join(dir, 'recognition.json');
    writeFileSync(path, JSON.stringify({
      partner: { model: 'grok-4.6', api: 'responses', timeoutMs: 1, retries: 0 },
      google: { timeoutMs: 1, retries: 0 },
      confusionFrom: '2026-10-01',
    }));
    expect(loadRecognitionConfig(path)).toMatchObject({ partnerMode: 'always', maxStrokeDelta: 1 });
  });

  // The config loads for every command: a typo here must not stop generate or push.
  it('reads a partner mode it does not know as off, with a warning, rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xiehanzi-cfg-'));
    const path = join(dir, 'recognition.json');
    writeFileSync(path, JSON.stringify({ partnerMode: 'sometimes' }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(loadRecognitionConfig(path).partnerMode).toBe('off');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/partnerMode.*sometimes.*off/);
    } finally {
      warn.mockRestore();
    }
  });
});
