import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueueStore, resolveDate } from './queue.js';

const TODAY = new Date('2026-08-19T12:00:00');
let file: string;

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'xiehanzi-')), 'queue.json');
});

const store = () => createQueueStore(file, { now: () => TODAY });

describe('resolveDate', () => {
  it('understands today and tomorrow', () => {
    expect(resolveDate('today', TODAY)).toBe('2026-08-19');
    expect(resolveDate('tomorrow', TODAY)).toBe('2026-08-20');
  });

  it('rolls over month ends', () => {
    expect(resolveDate('tomorrow', new Date('2026-08-31T12:00:00'))).toBe('2026-09-01');
  });

  it('passes an explicit ISO date through', () => {
    expect(resolveDate('2026-12-25', TODAY)).toBe('2026-12-25');
  });

  it('treats undefined as no date — next available sheet', () => {
    expect(resolveDate(undefined, TODAY)).toBeNull();
  });

  it('rejects nonsense rather than silently guessing', () => {
    expect(() => resolveDate('next tuesday', TODAY)).toThrow(/next tuesday/);
    expect(() => resolveDate('2026-13-45', TODAY)).toThrow();
  });
});

describe('queue store', () => {
  it('starts empty when the file does not exist', () => {
    expect(store().all()).toEqual([]);
  });

  it('adds characters with a timestamp', () => {
    const added = store().add(['惯', '父']);
    expect(added.map((e) => e.char)).toEqual(['惯', '父']);
    expect(added[0]!.date).toBeNull();
    expect(added[0]!.addedAt).toBe(TODAY.toISOString());
  });

  it('persists across instances', () => {
    store().add(['惯'], { date: '2026-08-20' });
    expect(store().all().map((e) => e.char)).toEqual(['惯']);
  });

  it('keeps the source word when given decomposed input', () => {
    const added = store().add([{ char: '塑', sourceWord: '塑料' }]);
    expect(added[0]!.sourceWord).toBe('塑料');
  });

  it('does not duplicate a character already pending for the same date', () => {
    const s = store();
    s.add(['惯'], { date: '2026-08-20' });
    const again = s.add(['惯'], { date: '2026-08-20' });
    expect(again).toEqual([]);
    expect(s.all()).toHaveLength(1);
  });

  it('allows the same character pinned to a different date', () => {
    const s = store();
    s.add(['惯'], { date: '2026-08-20' });
    s.add(['惯'], { date: '2026-08-21' });
    expect(s.all()).toHaveLength(2);
  });

  it('allows re-adding a character that was already consumed', () => {
    const s = store();
    s.add(['惯'], { date: '2026-08-19' });
    s.consume(['惯'], '2026-08-19');
    expect(s.add(['惯'], { date: '2026-08-19' })).toHaveLength(1);
  });
});

describe('queue store — pending', () => {
  it('returns entries pinned to the date plus undated ones', () => {
    const s = store();
    s.add(['甲'], { date: '2026-08-19' });
    s.add(['乙']);
    s.add(['丙'], { date: '2026-08-21' });
    expect(s.pending('2026-08-19').map((e) => e.char)).toEqual(['甲', '乙']);
  });

  it('puts date-pinned entries before undated ones', () => {
    const s = store();
    s.add(['乙']);
    s.add(['甲'], { date: '2026-08-19' });
    expect(s.pending('2026-08-19').map((e) => e.char)).toEqual(['甲', '乙']);
  });

  it('includes overdue pins that were never consumed', () => {
    const s = store();
    s.add(['甲'], { date: '2026-08-17' });
    expect(s.pending('2026-08-19').map((e) => e.char)).toEqual(['甲']);
  });

  it('excludes consumed entries', () => {
    const s = store();
    s.add(['甲', '乙'], { date: '2026-08-19' });
    s.consume(['甲'], '2026-08-19');
    expect(s.pending('2026-08-19').map((e) => e.char)).toEqual(['乙']);
  });
});

describe('queue store — consume', () => {
  it('archives rather than deletes', () => {
    const s = store();
    s.add(['甲'], { date: '2026-08-19' });
    s.consume(['甲'], '2026-08-19');

    expect(s.all()).toHaveLength(1);
    expect(s.all()[0]!.consumedOn).toBe('2026-08-19');
  });

  it('is idempotent — a second sheet on the same date changes nothing', () => {
    const s = store();
    s.add(['甲'], { date: '2026-08-19' });
    s.consume(['甲'], '2026-08-19');
    s.consume(['甲'], '2026-08-19');
    expect(s.all().filter((e) => e.consumedOn !== undefined)).toHaveLength(1);
  });
});

describe('queue store — durability', () => {
  it('writes valid JSON that a human can read and edit', () => {
    store().add(['惯'], { date: '2026-08-20', note: 'from the podcast' });
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toContain('\n'); // pretty-printed, not one line
  });

  it('refuses to start from a corrupt file rather than silently losing pins', () => {
    writeFileSync(file, '{ this is not json');
    expect(() => store().all()).toThrow(/queue/i);
  });

  it('leaves no temp file behind', () => {
    store().add(['惯']);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
