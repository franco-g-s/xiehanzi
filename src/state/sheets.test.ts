import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSheetStore } from './sheets.js';

let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'xiehanzi-sheets-')), 'sheets.json');
});
const store = () => createSheetStore(file, { now: () => new Date('2026-08-20T06:00:00Z') });

const sheet = (date: string, chars: Array<[string, string]>) => ({
  date,
  characters: chars.map(([char, reason]) => ({ char, reason: reason as never })),
});

describe('sheet store', () => {
  it('has no sheet for a date that was never generated', () => {
    expect(store().getSheet('2026-08-20')).toBeNull();
  });

  it('round-trips a sheet through disk', () => {
    store().saveSheet(sheet('2026-08-20', [['的', 'linear'], ['是', 'linear']]));
    expect(store().getSheet('2026-08-20')!.characters.map((c) => c.char)).toEqual(['的', '是']);
  });

  it('stamps when the sheet was generated', () => {
    store().saveSheet(sheet('2026-08-20', [['的', 'linear']]));
    expect(store().getSheet('2026-08-20')!.generatedAt).toBe('2026-08-20T06:00:00.000Z');
  });

  it('keeps sheets for different dates side by side', () => {
    const s = store();
    s.saveSheet(sheet('2026-08-19', [['的', 'linear']]));
    s.saveSheet(sheet('2026-08-20', [['是', 'linear']]));
    expect(s.getSheet('2026-08-19')!.characters[0]!.char).toBe('的');
    expect(s.getSheet('2026-08-20')!.characters[0]!.char).toBe('是');
  });

  it('replaces a sheet regenerated for the same date', () => {
    const s = store();
    s.saveSheet(sheet('2026-08-20', [['的', 'linear']]));
    s.saveSheet(sheet('2026-08-20', [['是', 'linear']]));
    expect(s.getSheet('2026-08-20')!.characters.map((c) => c.char)).toEqual(['是']);
  });
});

describe('sheet store — linear progress', () => {
  // Progress is DERIVED from the sheets, never stored separately: two copies of the same
  // fact drift, and a drifted cursor silently reprints characters or skips them.
  it('derives what linear has covered from the sheets themselves', () => {
    const s = store();
    s.saveSheet(sheet('2026-08-19', [['的', 'linear'], ['是', 'linear']]));
    s.saveSheet(sheet('2026-08-20', [['在', 'linear']]));
    expect(s.linearDone().sort()).toEqual(['在', '是', '的'].sort());
  });

  it('counts only characters linear actually chose', () => {
    const s = store();
    s.saveSheet(
      sheet('2026-08-20', [['的', 'linear'], ['塑', 'manual'], ['料', 'hard'], ['惯', 'class']]),
    );
    expect(s.linearDone()).toEqual(['的']);
  });

  it('is empty before anything is generated', () => {
    expect(store().linearDone()).toEqual([]);
  });

  it('does not double-count a character that appears twice', () => {
    const s = store();
    s.saveSheet(sheet('2026-08-19', [['的', 'linear']]));
    s.saveSheet(sheet('2026-08-20', [['的', 'linear']]));
    expect(s.linearDone()).toEqual(['的']);
  });
});

describe('sheet store — recall', () => {
  it('keeps recall rows and the geometry they were printed with', () => {
    const s = store();
    const geometry = { cellMm: 12.5, originXMm: 14, originYMm: 15.4,
                       rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11 };
    s.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '城', reason: 'linear' as never }],
      recall: [{ char: '市', cue: '城＿ chéngshì · city', page: 0, row: 0 }],
      recallGeometry: geometry,
    });
    const saved = s.getSheet('2026-08-22')!;
    expect(saved.recall).toHaveLength(1);
    expect(saved.recallGeometry).toEqual(geometry);
  });

  it('still reads manifests written before recall existed', () => {
    writeFileSync(file, JSON.stringify({ version: 1, sheets: { '2026-08-20': {
      date: '2026-08-20', characters: [{ char: '城', reason: 'linear' }],
      generatedAt: '2026-08-20T06:00:00.000Z',
    } } }));
    const saved = store().getSheet('2026-08-20')!;
    expect(saved.recall).toBeUndefined();
    expect(saved.characters).toHaveLength(1);
  });

  it('excludes recall characters from linear position', () => {
    // Recall re-tests what drilling already covered. Counting a recall row as linear
    // progress would skip that character in the catch-up walk.
    const s = store();
    s.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '城', reason: 'linear' as never }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
    });
    expect(s.linearDone()).toEqual(['城']);
  });

  // Defence in depth for the corruption class this whole file exists to prevent: a caller
  // that only knows about characters — like planSheet's drill-half save — must not be able
  // to silently erase a recall record it does not even know exists.
  it('preserves an existing recall record when a later save omits it entirely', () => {
    const s = store();
    const geometry = { cellMm: 12.5, originXMm: 14, originYMm: 15.4,
                       rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11 };
    s.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '城', reason: 'linear' as never }],
      recall: [{ char: '市', cue: '城＿ chéngshì · city', page: 0, row: 0 }],
      recallGeometry: geometry,
    });

    // A caller unaware of recall — no `recall` or `recallGeometry` key at all.
    s.saveSheet({ date: '2026-08-22', characters: [{ char: '城', reason: 'linear' as never }] });

    const saved = s.getSheet('2026-08-22')!;
    expect(saved.recall).toEqual([{ char: '市', cue: '城＿ chéngshì · city', page: 0, row: 0 }]);
    expect(saved.recallGeometry).toEqual(geometry);
  });

  it('still lets an explicit recall input replace what was there before', () => {
    const s = store();
    const geometry = { cellMm: 12.5, originXMm: 14, originYMm: 15.4,
                       rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11 };
    s.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '城', reason: 'linear' as never }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
      recallGeometry: geometry,
    });

    s.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '城', reason: 'linear' as never }],
      recall: [{ char: '页', cue: '……', page: 0, row: 0 }],
      recallGeometry: geometry,
    });

    expect(s.getSheet('2026-08-22')!.recall).toEqual([{ char: '页', cue: '……', page: 0, row: 0 }]);
  });
});

describe('sheet store — durability', () => {
  it('writes readable, editable JSON', () => {
    store().saveSheet(sheet('2026-08-20', [['的', 'linear']]));
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('\n');
    expect(JSON.parse(raw)).toHaveProperty('sheets');
  });

  it('refuses a corrupt file rather than silently losing all progress', () => {
    writeFileSync(file, 'not json at all');
    expect(() => store().linearDone()).toThrow(/sheet/i);
  });
});

describe('carrySheet', () => {
  it('moves a manifest to a later date, keeping generatedAt and recording where it came from', () => {
    const store = createSheetStore(join(mkdtempSync(join(tmpdir(), 'carry-')), 's.json'), { now: () => new Date('2026-10-03T06:20:00Z') });
    store.saveSheet({ date: '2026-10-03', characters: [{ char: '二', reason: 'linear' }] });

    store.carrySheet('2026-10-03', '2026-10-04');
    const twice = store.carrySheet('2026-10-04', '2026-10-05');

    expect(store.getSheet('2026-10-03')).toBeNull();
    expect(store.getSheet('2026-10-04')).toBeNull();
    expect(twice.carriedFrom).toEqual(['2026-10-03', '2026-10-04']);
    expect(twice.generatedAt).toBe('2026-10-03T06:20:00.000Z');
    expect(() => store.carrySheet('2026-10-05', '2026-10-05')).toThrow(/already has a sheet/);
  });

  it('a reprint of a carried date keeps carriedFrom', () => {
    const store = createSheetStore(join(mkdtempSync(join(tmpdir(), 'carry-')), 's.json'));
    store.saveSheet({ date: '2026-10-03', characters: [{ char: '二', reason: 'linear' }] });
    store.carrySheet('2026-10-03', '2026-10-04');

    store.saveSheet({ date: '2026-10-04', characters: [{ char: '二', reason: 'linear' }] });

    expect(store.getSheet('2026-10-04')!.carriedFrom).toEqual(['2026-10-03']);
  });
});
