import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gradeSession } from './session.js';
import { createReviewStore } from '../state/reviews.js';
import { createSheetStore } from '../state/sheets.js';
import { cellRect } from './grade.js';
import { writeNote } from '../deliver/note/write.js';
import { blankLayer, encodeRle, RLE } from '../deliver/note/rle.js';
import type { SupernoteCloud, CloudEntry } from '../deliver/supernote/cloud.js';
import type { RecallGeometry } from '../state/sheets.js';
import type { Recognisers } from './recognise/http.js';

const PAGE_W = 1920, PAGE_H = 2560, PAGE_W_MM = 162.6, PAGE_H_MM = 216.7;

const geometry: RecallGeometry = {
  cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11,
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xiehanzi-grade-')); });

/** A writing layer whose only ink fills the given (row, cell) pairs. */
function writingWithInkAtCells(cells: readonly [row: number, cell: number][]): Buffer {
  const pixels = new Uint8Array(PAGE_W * PAGE_H).fill(RLE.background);
  for (const [row, cell] of cells) {
    const r = cellRect(geometry, row, cell);
    const x0 = Math.round((r.xMm / PAGE_W_MM) * PAGE_W);
    const x1 = Math.round(((r.xMm + r.widthMm) / PAGE_W_MM) * PAGE_W);
    const y0 = Math.round((r.yMm / PAGE_H_MM) * PAGE_H);
    const y1 = Math.round(((r.yMm + r.heightMm) / PAGE_H_MM) * PAGE_H);
    for (let y = y0; y < y1; y += 1) pixels.fill(RLE.black, y * PAGE_W + x0, y * PAGE_W + x1);
  }
  return encodeRle(pixels);
}

/** A writing layer whose only ink fills the first cell of the given rows. */
function writingWithInkInRows(rows: number[]): Buffer {
  return writingWithInkAtCells(rows.map((row) => [row, 0]));
}

function noteBytes(writing?: Buffer): Buffer {
  // exactOptionalPropertyTypes rejects `writing: undefined` outright — the property has to
  // be absent, not merely undefined, when there is no writing to carry.
  return writeNote(
    [{ background: blankLayer(PAGE_W, PAGE_H), ...(writing === undefined ? {} : { writing }) }],
    { seed: 'grade-test' },
  );
}

function fakeCloud(bytes: Buffer) {
  const entry: CloudEntry = {
    id: 'f1', directoryId: 'd1', fileName: '2026-08-22 写汉字.note',
    isFolder: false, md5: '', size: bytes.length, updateTime: 1,
  };
  return {
    login: vi.fn(async () => 'token'),
    listDirectory: vi.fn(async () => [entry]),
    ensureDirectory: vi.fn(async () => 'd1'),
    resolveDirectory: vi.fn(async (): Promise<string | undefined> => 'd1'),
    findEntry: vi.fn(async () => entry),
    uploadFile: vi.fn(async () => ({ md5: '' })),
    deleteEntry: vi.fn(async () => {}),
    renameEntry: vi.fn(async () => {}),
    revertDelete: vi.fn(async () => {}),
    downloadFile: vi.fn(async () => bytes),
    requestVerification: vi.fn(async () => ({ email: 'a@b.c', timestamp: 1, validCodeKey: 'k' })),
    verify: vi.fn(async () => 'token'),
    useToken: vi.fn(),
  } satisfies SupernoteCloud & Record<string, unknown>;
}

/** A sheet store already holding a manifest with two recall rows on page 0. */
function seededSheets(chars = ['市', '城']) {
  const sheets = createSheetStore(join(dir, 'sheets.json'));
  sheets.saveSheet({
    date: '2026-08-22',
    characters: chars.map((char) => ({ char, reason: 'linear' as const })),
    recall: chars.map((char, row) => ({ char, cue: '…', page: 0, row })),
    recallGeometry: geometry,
  });
  return sheets;
}

/**
 * A fake recogniser reading the given characters in call order. Cells are read one at a
 * time in row order, so for the rows that carry ink this is row order too.
 */
function echo(name: string, chars: string[]) {
  let i = 0;
  return { name, recognise: vi.fn(async () => ({ source: name, candidates: [chars[i++] ?? '?'] })) };
}

/** A fake recogniser giving the scripted answers in call order; `null` is "unavailable". */
function scripted(name: string, answers: (string | null)[]) {
  let i = 0;
  return {
    name,
    recognise: vi.fn(async () => {
      const a = answers[i++];
      return a === null || a === undefined ? null : { source: name, candidates: [a] };
    }),
  };
}

function deps(cloud: SupernoteCloud, sheets = seededSheets(), recognisers?: Recognisers) {
  return {
    cloud: () => cloud,
    sheets,
    reviews: createReviewStore(join(dir, 'reviews.json')),
    remoteDir: 'Note/中文/写汉字',
    fileName: (date: string) => `${date} 写汉字.note`,
    pageWidthMm: PAGE_W_MM,
    pageHeightMm: PAGE_H_MM,
    recognisers: recognisers ?? { google: echo('google', ['市', '城']), partner: echo('go:grok-4.6', ['市', '城']) },
    eligible: () => new Set(['市', '城']),
    confusionFrom: '2026-10-01',
    partnerMode: 'always' as const,
    maxStrokeDelta: 1,
  };
}

describe('gradeSession', () => {
  it('appends one review per row that has evidence', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.graded).toBe(2);
    expect(summary.passed).toBe(2);
    expect(d.reviews.all()).toHaveLength(2);
  });

  it('fails a row whose first cell is blank while ink follows in the SAME row', async () => {
    // Cell 1 of row 0 (市) is blank; ink instead sits in cell 2 of that same row — checking
    // the solutions page and writing the correction, exactly what the ladder is for.
    const d = deps(fakeCloud(noteBytes(writingWithInkAtCells([[0, 2]]))));
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.graded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(d.reviews.all().find((r) => r.char === '市')!.result).toBe('fail');
  });

  // CRITICAL: grading a half-finished sheet must not fail every row below the one Franco
  // actually reached. Row 0 (市) has ink; row 1 (城) has none anywhere — it was simply
  // never reached, and must carry forward rather than being recorded as a false failure.
  it('leaves a row with no ink of its own ungraded, even though an earlier row has ink', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.graded).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(d.reviews.all()).toHaveLength(1);
    expect(d.reviews.all()[0]!.char).toBe('市');
  });

  it('grades the same date twice without doubling the reviews', async () => {
    // The scheduled job retries. A doubled review would double-advance the interval.
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    await gradeSession(d, { date: '2026-08-22' });
    const again = await gradeSession(d, { date: '2026-08-22' });

    expect(again.skipped).toBe('already-graded');
    expect(d.reviews.all()).toHaveLength(2);
  });

  it('reports no-sheet when the date has no manifest', async () => {
    const d = deps(fakeCloud(noteBytes()));
    const summary = await gradeSession(d, { date: '2026-01-01' });

    expect(summary.skipped).toBe('no-sheet');
    expect(d.reviews.all()).toEqual([]);
  });

  it('reports not-attempted and appends nothing for an untouched sheet', async () => {
    // The file IS on Supernote Cloud, but has no ink on it — Franco has not opened it yet.
    const d = deps(fakeCloud(noteBytes()));
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.skipped).toBe('not-attempted');
    expect(d.reviews.all()).toEqual([]);
  });

  // A 'not-attempted' sheet asks a question the summary could not previously answer: did
  // the device never sync, or did Franco genuinely not write? Those look identical in the
  // log and need opposite responses. The cloud's own updateTime separates them — a stamp
  // still reading the morning's push means nothing has been uploaded since. Franco spent a
  // session on exactly this question on 2026-09-23, having to date the upload from a
  // backup job's log, because the summary threw this away.
  it('reports the cloud copy\'s updateTime for an untouched sheet', async () => {
    const cloud = fakeCloud(noteBytes());
    const entry = await cloud.findEntry();
    entry.updateTime = Date.UTC(2026, 8, 22, 4, 20, 9);
    const d = deps(cloud);
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.skipped).toBe('not-attempted');
    expect(summary.cloudUpdatedAt).toBe(Date.UTC(2026, 8, 22, 4, 20, 9));
  });

  // Nothing was found on the cloud, so there is no stamp to report — and a zero or a
  // today's-date default here would read as a fresh upload, which is the opposite of true.
  it('reports no updateTime when the file is not on the cloud at all', async () => {
    const cloud: SupernoteCloud = fakeCloud(noteBytes());
    cloud.findEntry = async () => undefined;
    const summary = await gradeSession(deps(cloud), { date: '2026-08-22' });

    expect(summary.skipped).toBe('not-delivered');
    expect(summary.cloudUpdatedAt).toBeNull();
  });

  // CRITICAL: these two "nothing to grade" outcomes must stay distinguishable in the logs.
  // 'not-attempted' means the file came back but has no ink — an ordinary skipped morning.
  // 'not-delivered' means the file is not on the cloud at all — push failed, or the device
  // never synced back. The second is the shape a PERMANENT breakage takes: it would exit 0
  // quietly, day after day, while the schedule silently stopped advancing, and nothing in
  // the summary would tell the difference from an ordinary skip.
  it('reports not-delivered, distinct from not-attempted, when the file is absent from the cloud', async () => {
    const cloud: SupernoteCloud = fakeCloud(noteBytes());
    cloud.findEntry = async () => undefined;
    const d = deps(cloud);
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.skipped).toBe('not-delivered');
    expect(summary.skipped).not.toBe('not-attempted');
    expect(d.reviews.all()).toEqual([]);
  });

  it('does not download anything when the file is absent from the cloud', async () => {
    const cloud: SupernoteCloud = fakeCloud(noteBytes());
    cloud.findEntry = async () => undefined;
    await gradeSession(deps(cloud), { date: '2026-08-22' });
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  it('does not download anything when there is no sheet to grade', async () => {
    const cloud = fakeCloud(noteBytes());
    await gradeSession(deps(cloud), { date: '2026-01-01' });
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  it('never acquires a cloud client at all when there is no manifest for the date', async () => {
    // Acquiring a client can mean loading a saved session, which can fail outright — that
    // must not happen for a date that turns out to have nothing to grade. A factory that
    // throws if called proves the ordering, rather than merely observing which spies fired
    // on a client that was already sitting there ready to use.
    const d = { ...deps(fakeCloud(noteBytes())), cloud: () => { throw new Error('cloud should not have been touched'); } };
    const summary = await gradeSession(d, { date: '2026-01-01' });
    expect(summary.skipped).toBe('no-sheet');
  });

  it('never acquires a cloud client for a date that is already graded', async () => {
    const cloud = fakeCloud(noteBytes(writingWithInkInRows([0, 1])));
    const base = deps(cloud);
    await gradeSession(base, { date: '2026-08-22' });

    const throwingCloud = () => { throw new Error('cloud should not have been touched'); };
    const summary = await gradeSession({ ...base, cloud: throwingCloud }, { date: '2026-08-22' });
    expect(summary.skipped).toBe('already-graded');
  });

  it('uses the geometry stored on the manifest, not the current config', async () => {
    // Regrading an old sheet after a layout change must measure ink against the layout
    // that sheet was actually printed with.
    const shifted: RecallGeometry = { ...geometry, originYMm: geometry.originYMm + 40 };
    const sheets = createSheetStore(join(dir, 'sheets.json'));
    sheets.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '市', reason: 'linear' }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
      recallGeometry: shifted,
    });

    // Ink placed using the SHIFTED geometry must still be found.
    const pixels = new Uint8Array(PAGE_W * PAGE_H).fill(RLE.background);
    const r = { ...cellRect(geometry, 0, 0), yMm: shifted.originYMm };
    const x0 = Math.round((r.xMm / PAGE_W_MM) * PAGE_W);
    const x1 = Math.round(((r.xMm + r.widthMm) / PAGE_W_MM) * PAGE_W);
    const y0 = Math.round((r.yMm / PAGE_H_MM) * PAGE_H);
    const y1 = Math.round(((r.yMm + shifted.cellMm) / PAGE_H_MM) * PAGE_H);
    for (let y = y0; y < y1; y += 1) pixels.fill(RLE.black, y * PAGE_W + x0, y * PAGE_W + x1);

    const d = deps(fakeCloud(noteBytes(encodeRle(pixels))), sheets);
    expect((await gradeSession(d, { date: '2026-08-22' })).graded).toBe(1);
  });

  it('flags a character that has failed three times with the same reading', async () => {
    // A person who has forgotten a character writes different wrong things on different
    // days. A recogniser misreads the same correct glyph identically every time.
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-19', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-20', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-21', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
    ]);
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.suspectedMisreads).toContain('城');
  });

  it('does not flag three failures with different readings', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-19', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-20', char: '城', result: 'fail', evidence: 'transcription', read: '诚' },
      { date: '2026-08-21', char: '城', result: 'fail', evidence: 'transcription', read: '城市' },
    ]);
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.suspectedMisreads).not.toContain('城');
  });

  // CRITICAL: the streak must be the character's CURRENT trailing streak, not "did a
  // streak of 3 ever occur anywhere in history". A character misread three times in a row
  // months ago but written correctly and passed since must not still be flagged today.
  it('does not flag a character whose misread streak was broken by later clean passes', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-10', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-11', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-12', char: '城', result: 'fail', evidence: 'transcription', read: '成' },
      { date: '2026-08-13', char: '城', result: 'pass', evidence: 'transcription', read: '城' },
      { date: '2026-08-14', char: '城', result: 'pass', evidence: 'transcription', read: '城' },
    ]);
    // Today's grading only touches 市 (row 0 has ink; row 1 does not) — 城 stays untouched
    // so its history is exactly what was appended above.
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.suspectedMisreads).not.toContain('城');
  });

  it('does not flag failures graded from ink, which read nothing at all', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-19', char: '城', result: 'fail', evidence: 'ink' },
      { date: '2026-08-20', char: '城', result: 'fail', evidence: 'ink' },
      { date: '2026-08-21', char: '城', result: 'fail', evidence: 'ink' },
    ]);
    expect((await gradeSession(d, { date: '2026-08-22' })).suspectedMisreads).toEqual([]);
  });

  it('flags a character the recognisers have failed three times with the same reading', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-19', char: '真', result: 'fail', evidence: 'recognition', read: '直' },
      { date: '2026-08-20', char: '真', result: 'fail', evidence: 'recognition', read: '直' },
      { date: '2026-08-21', char: '真', result: 'fail', evidence: 'recognition', read: '直' },
    ]);
    expect((await gradeSession(d, { date: '2026-08-22' })).suspectedMisreads).toEqual(['真']);
  });

  // A confusion fail is the character Franco wrote by mistake, failed for being confused:
  // its `read` is itself, so three of them say nothing about a recogniser.
  it('does not flag confusion fails', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))));
    d.reviews.append([
      { date: '2026-08-19', char: '待', result: 'fail', evidence: 'confusion', read: '待', asked: '持' },
      { date: '2026-08-20', char: '待', result: 'fail', evidence: 'confusion', read: '待', asked: '持' },
      { date: '2026-08-21', char: '待', result: 'fail', evidence: 'confusion', read: '待', asked: '持' },
    ]);
    expect((await gradeSession(d, { date: '2026-08-22' })).suspectedMisreads).toEqual([]);
  });

  it('counts which kind of evidence produced each verdict', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.evidence).toEqual({ transcription: 0, ink: 0, recognition: 2, confusion: 0 });
  });

  it('does not append anything on a dry run', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    const summary = await gradeSession(d, { date: '2026-08-22', dryRun: true });

    expect(summary.graded).toBe(2);
    expect(d.reviews.all()).toEqual([]);
  });

  it('grades each row against its own page in a multi-page note', async () => {
    // Ink sits at a DIFFERENT row index on each page. If page 1's rows were ever graded
    // against page 0's pixels (or vice versa), the row would land on a blank cell on a
    // page that nonetheless has ink elsewhere, and the ladder would call it a wrongly
    // confident fail rather than an accidental pass — so a page mix-up cannot hide here.
    const sheets = createSheetStore(join(dir, 'sheets.json'));
    sheets.saveSheet({
      date: '2026-08-22',
      characters: [
        { char: '市', reason: 'linear' },
        { char: '城', reason: 'linear' },
        { char: '程', reason: 'linear' },
      ],
      recall: [
        { char: '市', cue: '…', page: 0, row: 0 },
        { char: '城', cue: '…', page: 1, row: 3 },
        // No page 2 in the note at all — must be skipped quietly, not throw.
        { char: '程', cue: '…', page: 2, row: 0 },
      ],
      recallGeometry: geometry,
    });

    const page0Writing = writingWithInkInRows([0]);
    const page1Writing = writingWithInkInRows([3]);
    const bytes = writeNote(
      [
        { background: blankLayer(PAGE_W, PAGE_H), writing: page0Writing },
        { background: blankLayer(PAGE_W, PAGE_H), writing: page1Writing },
      ],
      { seed: 'grade-test-multipage' },
    );

    const d = deps(fakeCloud(bytes), sheets);
    const summary = await gradeSession(d, { date: '2026-08-22' });

    // The page-2 row has nowhere to be graded and is skipped, not thrown on.
    expect(summary.graded).toBe(2);
    expect(summary.passed).toBe(2);
    expect(d.reviews.all().find((r) => r.char === '市')!.result).toBe('pass');
    expect(d.reviews.all().find((r) => r.char === '城')!.result).toBe('pass');
    expect(d.reviews.all().find((r) => r.char === '程')).toBeUndefined();
  });

  // A recogniser that fails for one night must not erase a verdict that already counts:
  // a new revision replaces the whole date in replay, so anything it omits is gone.
  it('keeps the earlier verdict for a cell that comes back unreadable', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))), seededSheets(),
      { google: echo('google', ['市', '城']), partner: null });
    await gradeSession(d, { date: '2026-08-22' });

    await gradeSession(
      { ...d, recognisers: { google: scripted('google', [null, '城']), partner: scripted('go:grok-4.6', [null, '城']) } },
      { date: '2026-08-22' },
    );
    expect(d.reviews.latestForDate('2026-08-22')).toEqual(expect.arrayContaining([
      expect.objectContaining({ char: '市', result: 'pass' }),
      expect.objectContaining({ char: '城', result: 'pass' }),
    ]));
  });

  it('carries the unreadable cell into a new revision recorded for another change', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))), seededSheets(),
      { google: echo('google', ['市', '城']), partner: null });
    await gradeSession(d, { date: '2026-08-22' });

    // 城 now fails: the partner reads 成, so 城 is not among its candidates.
    const summary = await gradeSession(
      { ...d, recognisers: { google: scripted('google', [null, '城']), partner: scripted('go:grok-4.6', [null, '成']) } },
      { date: '2026-08-22' },
    );
    expect(summary.changes).toEqual([{ char: '城', from: 'pass', to: 'fail' }]);
    expect(summary.degraded).toBe(true);
    const latest = d.reviews.latestForDate('2026-08-22');
    expect(latest).toHaveLength(2);
    expect(latest.every((r) => r.revision === 1 && r.degraded === true)).toBe(true);
    expect(latest.find((r) => r.char === '市')).toMatchObject({ result: 'pass' });
  });

  // A legacy `ink` pass only ever meant "something was written here". Keeping it for a
  // cell nothing can read would preserve exactly the false pass a re-grade exists to remove.
  it('drops a legacy ink pass for a cell that comes back unreadable', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    d.reviews.append([
      { date: '2026-08-22', char: '市', result: 'pass', evidence: 'ink' },
      { date: '2026-08-22', char: '城', result: 'pass', evidence: 'transcription', read: '城' },
    ]);
    const summary = await gradeSession(
      { ...d, recognisers: { google: scripted('google', [null, '城']), partner: scripted('go:grok-4.6', [null, '城']) } },
      { date: '2026-08-22', force: true },
    );
    expect(summary.changes).toEqual([{ char: '市', from: 'pass', to: null }]);
    const latest = d.reviews.latestForDate('2026-08-22');
    expect(latest.find((r) => r.char === '市')).toBeUndefined();
    expect(latest.find((r) => r.char === '城')).toMatchObject({ result: 'pass', revision: 1 });
  });

  it('drops a legacy ink pass even when no cell on the date is readable, if other verdicts carry', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))), seededSheets(), { google: null, partner: null });
    d.reviews.append([
      { date: '2026-08-22', char: '市', result: 'pass', evidence: 'ink' },
      { date: '2026-08-22', char: '城', result: 'fail', evidence: 'ink' },
    ]);
    const summary = await gradeSession(d, { date: '2026-08-22', force: true });
    expect(summary.changes).toEqual([{ char: '市', from: 'pass', to: null }]);
    expect(summary.degraded).toBe(true);
    expect(d.reviews.latestForDate('2026-08-22')).toEqual([
      expect.objectContaining({ char: '城', result: 'fail', evidence: 'ink', revision: 1, degraded: true }),
    ]);
  });

  // A confusion fail belongs to the cell that asked for something else. When that cell
  // was just read again, its old confusion is stale, whatever happened to the other row.
  it('does not carry a confusion fail whose asking cell was re-graded', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    d.reviews.append([
      { date: '2026-08-22', char: '市', result: 'fail', evidence: 'recognition', read: '城' },
      { date: '2026-08-22', char: '城', result: 'pass', evidence: 'recognition', read: '城' },
      { date: '2026-08-22', char: '城', result: 'fail', evidence: 'confusion', read: '城', asked: '市' },
    ]);
    await gradeSession(
      { ...d, recognisers: { google: scripted('google', ['市', null]), partner: scripted('go:grok-4.6', ['市', null]) } },
      { date: '2026-08-22', force: true },
    );
    const latest = d.reviews.latestForDate('2026-08-22');
    expect(latest.find((r) => r.char === '城')).toMatchObject({ result: 'pass', evidence: 'recognition' });
    expect(latest.find((r) => r.evidence === 'confusion')).toBeUndefined();
  });

  it('reports a written sheet nothing could read as unreadable, not as a day off', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))), seededSheets(), { google: null, partner: null });
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.skipped).toBe('unreadable');
    expect(summary.ungraded).toBe(2);
    expect(d.reviews.all()).toEqual([]);
  });

  it('re-grades a degraded date and records the next revision once fully graded', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0]))), seededSheets(['市']),
      { google: echo('google', ['市']), partner: null });
    await gradeSession(d, { date: '2026-08-22' });
    expect(d.reviews.latestForDate('2026-08-22')[0]).toMatchObject({ degraded: true });

    const again = { ...d, recognisers: { google: echo('google', ['市']), partner: echo('go:grok-4.6', ['市']) } };
    const summary = await gradeSession(again, { date: '2026-08-22' });
    expect(summary.revision).toBe(1);
    expect(d.reviews.latestForDate('2026-08-22')).toEqual([
      expect.objectContaining({ char: '市', result: 'pass', revision: 1 }),
    ]);
    expect(d.reviews.latestForDate('2026-08-22')[0]!.degraded).toBeUndefined();
  });

  it('with the partner off, a Google-only date is finished, not degraded', async () => {
    const d = { ...deps(fakeCloud(noteBytes(writingWithInkInRows([0]))), seededSheets(['市']),
      { google: echo('google', ['市']), partner: null }), partnerMode: 'off' as const };
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.degraded).toBe(false);
    expect(summary.tiers[1]).toBe(1);
    expect(d.reviews.latestForDate('2026-08-22')[0]!.degraded).toBeUndefined();
    // So the nightly run leaves it alone instead of grading it again every night.
    expect((await gradeSession(d, { date: '2026-08-22' })).skipped).toBe('already-graded');
  });

  it('force re-grades a finished date but records nothing when no verdict changes', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    await gradeSession(d, { date: '2026-08-22' });
    const summary = await gradeSession(
      { ...d, recognisers: { google: echo('google', ['市', '城']), partner: echo('go:grok-4.6', ['市', '城']) } },
      { date: '2026-08-22', force: true },
    );
    expect(summary.skipped).toBe('unchanged');
    expect(d.reviews.all()).toHaveLength(2);
  });

  it('force re-grade records a correction as a new revision, with the changes listed', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([0, 1]))));
    await gradeSession(d, { date: '2026-08-22' });
    const summary = await gradeSession(
      { ...d, recognisers: { google: echo('google', ['市', '成']), partner: echo('go:grok-4.6', ['市', '成']) } },
      { date: '2026-08-22', force: true },
    );
    expect(summary.changes).toEqual([{ char: '城', from: 'pass', to: 'fail' }]);
    expect(d.reviews.latestForDate('2026-08-22').every((r) => r.revision === 1)).toBe(true);
  });

  it('reads a local copy of the note before going to the cloud', async () => {
    const cloud = fakeCloud(noteBytes());
    const d = { ...deps(cloud), localNote: () => noteBytes(writingWithInkInRows([0, 1])) };
    const summary = await gradeSession(d, { date: '2026-08-22' });
    expect(summary.graded).toBe(2);
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  it('applies the confusion rule only from confusionFrom on', async () => {
    const d = deps(fakeCloud(noteBytes(writingWithInkInRows([1]))), seededSheets(['市', '城']),
      { google: echo('google', ['市']), partner: echo('go:grok-4.6', ['市']) });
    const before = await gradeSession(d, { date: '2026-08-22' });
    expect(before.evidence.confusion).toBe(0);
  });
});

// Six sheets in state/sheets.json (2026-08-28 through 2026-09-02) were printed before the
// answers pages were interleaved, with 22 rows across recall pages 0 and 1 of a 11-row
// geometry. Those .note files are on the device and are still graded against those
// manifests, so `page` has to keep meaning what it meant when they were written: an index
// into the pages of the document, which for them really were 0 and 1.
describe('gradeSession — a manifest written before the answers pages were interleaved', () => {
  const printed: RecallGeometry = {
    cellMm: 12.499999999999998, originXMm: 14, originYMm: 15.4, rowPitchMm: 18.77,
    cellsPerRow: 6, rowsPerPage: 11, firstCellGapMm: 2.5,
  };

  /** Ink in the graded first cell of the given rows, measured on the printed geometry. */
  function ink(rows: readonly number[]): Buffer {
    const pixels = new Uint8Array(PAGE_W * PAGE_H).fill(RLE.background);
    for (const row of rows) {
      const r = cellRect(printed, row, 0);
      const x0 = Math.round((r.xMm / PAGE_W_MM) * PAGE_W);
      const x1 = Math.round(((r.xMm + r.widthMm) / PAGE_W_MM) * PAGE_W);
      const y0 = Math.round((r.yMm / PAGE_H_MM) * PAGE_H);
      const y1 = Math.round(((r.yMm + r.heightMm) / PAGE_H_MM) * PAGE_H);
      for (let y = y0; y < y1; y += 1) pixels.fill(RLE.black, y * PAGE_W + x0, y * PAGE_W + x1);
    }
    return encodeRle(pixels);
  }

  it('still grades each row against the consecutive page it was printed on', async () => {
    const sheets = createSheetStore(join(dir, 'sheets.json'));
    sheets.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '市', reason: 'linear' }, { char: '城', reason: 'linear' }],
      // The old order: recall on document pages 0 and 1, answers behind both of them.
      recall: [
        { char: '市', cue: '…', page: 0, row: 0 },
        { char: '城', cue: '…', page: 1, row: 4 },
      ],
      recallGeometry: printed,
    });

    const bytes = writeNote(
      [
        { background: blankLayer(PAGE_W, PAGE_H), writing: ink([0]) },
        { background: blankLayer(PAGE_W, PAGE_H), writing: ink([4]) },
        // The two answers pages that used to follow, blank as they always were.
        { background: blankLayer(PAGE_W, PAGE_H) },
        { background: blankLayer(PAGE_W, PAGE_H) },
      ],
      { seed: 'grade-test-preinterleave' },
    );

    const d = deps(fakeCloud(bytes), sheets);
    const summary = await gradeSession(d, { date: '2026-08-22' });

    expect(summary.graded).toBe(2);
    expect(d.reviews.all().find((r) => r.char === '市')!.result).toBe('pass');
    expect(d.reviews.all().find((r) => r.char === '城')!.result).toBe('pass');
  });
});
