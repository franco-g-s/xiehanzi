import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewStore } from './reviews.js';
import type { Review } from '../recall/schedule.js';

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reviews-')); path = join(dir, 'reviews.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const r = (date: string, char: string, result: 'pass' | 'fail' = 'pass'): Review =>
  ({ date, char, result, evidence: 'ink' });

describe('createReviewStore', () => {
  it('is empty before anything is written', () => {
    expect(createReviewStore(path).all()).toEqual([]);
  });

  it('appends without disturbing what is already there', () => {
    const store = createReviewStore(path);
    store.append([r('2026-08-21', '市')]);
    store.append([r('2026-08-22', '城')]);
    expect(store.all().map((x) => x.char)).toEqual(['市', '城']);
  });

  it('keeps the recogniser reading when one was recorded', () => {
    const store = createReviewStore(path);
    store.append([{ date: '2026-08-21', char: '避', result: 'fail', evidence: 'transcription', read: '辟' }]);
    expect(store.all()[0]!.read).toBe('辟');
  });

  it('reports what a date already holds, so a sheet is not graded twice', () => {
    const store = createReviewStore(path);
    store.append([r('2026-08-21', '市'), r('2026-08-22', '城')]);
    expect(store.forDate('2026-08-21').map((x) => x.char)).toEqual(['市']);
  });

  it('writes a trailing newline, so the file diffs cleanly in git', () => {
    createReviewStore(path).append([r('2026-08-21', '市')]);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('refuses to start over when the file is unreadable', () => {
    writeFileSync(path, 'not json at all');
    expect(() => createReviewStore(path).all()).toThrow(/refusing to start over/i);
  });

  it('survives a store reopened from disk', () => {
    createReviewStore(path).append([r('2026-08-21', '市')]);
    expect(createReviewStore(path).all()).toHaveLength(1);
  });

  it('latestForDate returns only the highest revision for that date', () => {
    const store = createReviewStore(join(dir, 'reviews.json'));
    store.append([{ date: '2026-09-02', char: '真', result: 'fail', evidence: 'transcription' }]);
    store.append([{ date: '2026-09-02', char: '真', result: 'pass', evidence: 'recognition', revision: 1 }]);
    expect(store.latestForDate('2026-09-02')).toEqual([
      { date: '2026-09-02', char: '真', result: 'pass', evidence: 'recognition', revision: 1 },
    ]);
    expect(store.forDate('2026-09-02')).toHaveLength(2);
  });
});
