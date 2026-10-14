import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './cli.js';
import type { CliDeps } from './cli.js';
import { createQueueStore } from './state/queue.js';
import { createSheetStore } from './state/sheets.js';
import { createReviewStore } from './state/reviews.js';
import { createCatalogue, parseCharList, parseFrequency } from './sources/hsk.js';
import { createExampleIndex } from './select/enrich.js';
import { createDictionary, parseCedict } from './dict/cedict.js';
import type { AnkiClient } from './sources/ankiconnect.js';
import { AnkiUnreachableError } from './sources/ankiconnect.js';
import { createGlossary, loadGlossary, EMPTY_GLOSSARY } from './sources/glossary.js';
import { DEFAULT_SHEET_CONFIG } from './render/layout.js';
import { cellRect } from './recall/grade.js';
import { writeNote } from './deliver/note/write.js';
import { blankLayer, encodeRle, RLE } from './deliver/note/rle.js';
import type { RecallGeometry } from './state/sheets.js';
import type { SupernoteCloud, CloudEntry } from './deliver/supernote/cloud.js';
import type { Recognisers } from './recall/recognise/http.js';

const DICT = createDictionary(
  parseCedict(['塑料 塑料 [su4 liao4] /plastic/', '了 了 [le5] /(particle)/', '了 了 [liao3] /to finish/'].join('\n')),
);

let out: string[];
let err: string[];
let queueFile: string;
let stateDir: string;

const HSK = createCatalogue(
  parseCharList('一级汉字表\n1\t一\n2\t二\n3\t三\n初等手写字表\n1\t一\n2\t二\n3\t三\n'),
  parseFrequency('1\t一\n2\t二\n3\t三\n'),
);

function deps(over: Partial<CliDeps> = {}): CliDeps {
  // Note 111 exists with one card, 222, sitting in the review queue.
  const anki = {
    invoke: vi.fn(async (action: string) =>
      action === 'notesInfo' ? [{ noteId: 111, cards: [222] }] : null,
    ),
    deckNames: async () => [],
    modelNames: async () => [],
    findNotes: vi.fn(async () => [111]),
    findCards: vi.fn(async (q: string) => (q.includes('-is:new -is:learn') ? [222] : [])),
  } as unknown as AnkiClient;

  return {
    queue: createQueueStore(queueFile, { now: () => new Date('2026-08-19T12:00:00') }),
    sheets: createSheetStore(join(stateDir, 'sheets.json'), {
      now: () => new Date('2026-08-19T12:00:00'),
    }),
    reviews: createReviewStore(join(stateDir, 'reviews.json')),
    dictionary: () => DICT,
    examples: () => createExampleIndex([{ term: '一二', level: 1 }]),
    glossary: () => EMPTY_GLOSSARY,
    glossaryPath: join(stateDir, 'anki-glossary.json'),
    glossaryDeck: 'HSK 3.0 Vocabulary',
    catalogue: () => HSK,
    anki: () => anki,
    vocab: () => undefined,
    writePdf: vi.fn(async () => {}),
    writeNoteFile: vi.fn(async () => {}),
    outDir: stateDir,
    remoteDir: 'Note/test',
    backupDir: join(stateDir, 'backup'),
    sessionPath: join(stateDir, 'session.json'),
    prompt: vi.fn(async () => '123456'),
    cloud: () => { throw new Error('cloud not configured in tests'); },
    backup: vi.fn(async () => ({ ok: true })),
    recognisers: () => ({ google: null, partner: null }),
    confusionFrom: '2026-10-01',
    partnerMode: 'always',
    maxStrokeDelta: 1,
    now: () => new Date('2026-08-19T12:00:00'),
    skip: ['一', '人'],
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    ...over,
  };
}

const RECALL_GEOMETRY: RecallGeometry = {
  cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11,
};

function seedRecallSheet(
  d: CliDeps,
  date: string,
  chars: string[],
  geometry: RecallGeometry = RECALL_GEOMETRY,
  drilled: string[] = chars,
): void {
  d.sheets.saveSheet({
    date,
    characters: drilled.map((char) => ({ char, reason: 'linear' as const })),
    recall: chars.map((char, row) => ({ char, cue: '…', page: 0, row })),
    recallGeometry: geometry,
  });
}

/** A written-on note in the local backup, inked in the first cell of each given row. */
function writeBackupNote(d: CliDeps, date: string, inkRows: number[], geometry: RecallGeometry = RECALL_GEOMETRY): void {
  const px = new Uint8Array(1920 * 2560).fill(RLE.background);
  for (const row of inkRows) {
    const r = cellRect(geometry, row, 0);
    const x0 = Math.round((r.xMm / 162.6) * 1920), x1 = Math.round(((r.xMm + r.widthMm) / 162.6) * 1920);
    const y0 = Math.round((r.yMm / 216.7) * 2560), y1 = Math.round(((r.yMm + r.heightMm) / 216.7) * 2560);
    for (let y = y0; y < y1; y += 1) px.fill(RLE.black, y * 1920 + x0, y * 1920 + x1);
  }
  const bytes = writeNote([{ background: blankLayer(1920, 2560), writing: encodeRle(px) }], { seed: 'cli-test' });
  const path = join(d.backupDir, d.remoteDir, `${date} 写汉字.note`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

beforeEach(() => {
  out = [];
  err = [];
  stateDir = mkdtempSync(join(tmpdir(), 'xiehanzi-cli-'));
  queueFile = join(stateDir, 'queue.json');
});

const text = () => out.join('\n');

describe('xiehanzi add', () => {
  it('queues characters and reports them', async () => {
    const d = deps();
    expect(await run(['add', '惯', '父'], d)).toBe(0);
    expect(d.queue.all().map((e) => e.char)).toEqual(['惯', '父']);
    expect(text()).toContain('惯');
  });

  it('accepts a word and queues its characters', async () => {
    const d = deps();
    await run(['add', '冰激凌'], d);
    expect(d.queue.all().map((e) => e.char)).toEqual(['冰', '激', '凌']);
  });

  it('honours --on=tomorrow', async () => {
    const d = deps();
    await run(['add', '惯', '--on=tomorrow'], d);
    expect(d.queue.all()[0]!.date).toBe('2026-08-20');
  });

  // The skip list filters automatic selection. Typing a character is an explicit
  // request, and a config default must not silently discard it.
  it('queues skip-list characters anyway when you ask for them by name', async () => {
    const d = deps();
    expect(await run(['add', '一', '人'], d)).toBe(0);
    expect(d.queue.all().map((e) => e.char)).toEqual(['一', '人']);
  });

  it('still notes that they are on the skip list', async () => {
    await run(['add', '一', '惯'], deps());
    expect(text()).toMatch(/skip list/i);
  });

  it('fails when given no characters', async () => {
    expect(await run(['add'], deps())).toBe(1);
    expect(err.join('')).toMatch(/character/i);
  });

  it('fails on an unparseable date rather than guessing', async () => {
    expect(await run(['add', '惯', '--on=next tuesday'], deps())).toBe(1);
    expect(err.join('')).toMatch(/next tuesday/);
  });

  it('reports when a character was already queued', async () => {
    const d = deps();
    await run(['add', '惯'], d);
    out = [];
    expect(await run(['add', '惯'], d)).toBe(0);
    expect(text()).toMatch(/already queued|nothing new/i);
  });
});

describe('xiehanzi queue', () => {
  it('reports an empty queue plainly', async () => {
    expect(await run(['queue'], deps())).toBe(0);
    expect(text()).toMatch(/nothing queued|empty/i);
  });

  it('lists pending pins with their dates', async () => {
    const d = deps();
    await run(['add', '惯', '--on=tomorrow'], d);
    await run(['add', '父'], d);
    out = [];

    expect(await run(['queue'], d)).toBe(0);
    expect(text()).toContain('惯');
    expect(text()).toContain('2026-08-20');
    expect(text()).toContain('父');
  });

  it('hides consumed entries', async () => {
    const d = deps();
    await run(['add', '惯'], d);
    d.queue.consume(['惯'], '2026-08-19');
    out = [];

    await run(['queue'], d);
    expect(text()).toMatch(/nothing queued|empty/i);
  });

  it('emits JSON with --json', async () => {
    const d = deps();
    await run(['add', '惯', '--on=tomorrow'], d);
    out = [];

    await run(['queue', '--json'], d);
    expect(JSON.parse(text())).toMatchObject({ pending: [{ char: '惯', date: '2026-08-20' }] });
  });
});

describe('xiehanzi lookup', () => {
  it('prints pinyin and definitions', async () => {
    expect(await run(['lookup', '塑料'], deps())).toBe(0);
    expect(text()).toContain('sùliào');
    expect(text()).toContain('plastic');
  });

  it('prints every reading for a homograph', async () => {
    await run(['lookup', '了'], deps());
    expect(text()).toContain('le');
    expect(text()).toContain('liǎo');
  });

  // A miss is a normal answer, not a failure — many phrases are simply absent.
  it('succeeds with a clear message when the term is absent', async () => {
    expect(await run(['lookup', '付诸实践'], deps())).toBe(0);
    expect(text()).toMatch(/no entry|not found/i);
  });

  it('emits machine-readable JSON with --json', async () => {
    await run(['lookup', '塑料', '--json'], deps());
    expect(JSON.parse(text())).toMatchObject({ term: '塑料', entries: [{ pinyin: 'sùliào' }] });
  });
});

describe('xiehanzi learn', () => {
  it('requires pinyin and meaning', async () => {
    expect(await run(['learn', '塑料'], deps())).toBe(1);
    expect(err.join('')).toMatch(/pinyin/i);
  });

  it('runs and reports what it did', async () => {
    const d = deps();
    expect(await run(['learn', '塑料', '--pinyin=sùliào', '--meaning=plastic'], d)).toBe(0);
    expect(text()).toMatch(/塑料/);
    expect(d.queue.all().map((e) => e.char)).toEqual(['塑', '料']);
  });

  it('phrases a dry run in the conditional, never as accomplished fact', async () => {
    const d = deps();
    await run(['learn', '塑料', '--pinyin=sùliào', '--meaning=plastic', '--dry-run'], d);

    // Leading with the disclaimer matters: an agent skimming past-tense output would
    // otherwise report a card it never wrote.
    expect(out[0]).toMatch(/dry run/i);
    expect(text()).toMatch(/would/i);
    expect(text()).not.toMatch(/^Created |^Found /m);
  });

  it('makes no writes on --dry-run', async () => {
    const d = deps();
    const backup = d.backup;
    await run(['learn', '塑料', '--pinyin=sùliào', '--meaning=plastic', '--dry-run'], d);
    expect(backup).not.toHaveBeenCalled();
    expect(d.queue.all()).toEqual([]);
  });

  it('emits JSON with --json so an agent can report truthfully', async () => {
    const d = deps();
    await run(['learn', '塑料', '--pinyin=sùliào', '--meaning=plastic', '--json'], d);
    expect(JSON.parse(text())).toMatchObject({ term: '塑料', action: 'setDueDate' });
  });

  it('surfaces a dictionary disagreement in the output', async () => {
    await run(['learn', '塑料', '--pinyin=WRONG', '--meaning=plastic'], deps());
    expect(text()).toMatch(/sùliào/);
  });
});

describe('xiehanzi — top level', () => {
  it('prints usage for --help and succeeds', async () => {
    expect(await run(['--help'], deps())).toBe(0);
    expect(text()).toMatch(/add/);
    expect(text()).toMatch(/learn/);
  });

  it('prints usage and fails for an unknown command', async () => {
    expect(await run(['frobnicate'], deps())).toBe(1);
    expect(err.join('')).toMatch(/frobnicate/);
  });

  it('prints usage and fails when given nothing', async () => {
    expect(await run([], deps())).toBe(1);
  });
});

describe('xiehanzi generate', () => {
  // The default is a real notebook: the point is writing on the device natively, with no
  // PDF import and therefore no .mark file.
  it('builds a .note by default', async () => {
    const d = deps();
    expect(await run(['generate', '--count=2', '--review=0'], d)).toBe(0);
    expect(text()).toMatch(/2 characters/);
    expect(d.writeNoteFile).toHaveBeenCalledOnce();
    expect(d.writePdf).not.toHaveBeenCalled();
  });

  it('names the file by date, for chronological sorting on the device', async () => {
    const d = deps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    const calls = (d.writeNoteFile as unknown as { mock: { calls: [string, string][] } }).mock.calls;
    expect(calls[0]![1]).toMatch(/2026-08-20 写汉字\.note$/);
  });

  it('still builds a PDF when asked', async () => {
    const d = deps();
    await run(['generate', '--count=2', '--review=0', '--format=pdf'], d);
    expect(d.writePdf).toHaveBeenCalledOnce();
    expect(d.writeNoteFile).not.toHaveBeenCalled();
  });

  it('builds both when asked', async () => {
    const d = deps();
    await run(['generate', '--count=2', '--review=0', '--format=both'], d);
    expect(d.writePdf).toHaveBeenCalledOnce();
    expect(d.writeNoteFile).toHaveBeenCalledOnce();
  });

  it('rejects an unknown format rather than silently choosing one', async () => {
    expect(await run(['generate', '--format=docx'], deps())).toBe(1);
    expect(err.join('')).toMatch(/format/i);
  });

  it('writes no file on a dry run and says so first', async () => {
    const d = deps();
    await run(['generate', '--count=2', '--review=0', '--dry-run'], d);
    expect(d.writePdf).not.toHaveBeenCalled();
    expect(d.writeNoteFile).not.toHaveBeenCalled();
    expect(out[0]).toMatch(/dry run/i);
  });

  it('reproduces the same sheet when run twice for one date', async () => {
    const d = deps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    out = [];
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    expect(text()).toMatch(/reused/i);
  });

  it('rejects a nonsense count rather than guessing', async () => {
    expect(await run(['generate', '--count=zero'], deps())).toBe(1);
    expect(err.join('')).toMatch(/count/i);
  });

  it('rejects an unparseable date', async () => {
    expect(await run(['generate', '--date=next tuesday'], deps())).toBe(1);
  });

  it('emits JSON for an agent', async () => {
    await run(['generate', '--count=2', '--review=0', '--json'], deps());
    expect(JSON.parse(text())).toMatchObject({ reused: false });
  });
});

describe('xiehanzi generate — the stored recall cue matches the printed one', () => {
  // 他们/你们/我们 all share 们 — exactly the cross-row collision recall.test.ts's buildCue
  // suite covers for the renderer. cli.ts built the MANIFEST's cue with a bare two-argument
  // buildCue(p, style) call, never passing sheetAnswers, so on a day both 他 and 们 are due
  // the manifest would record "＿们" for 他's row (们 leaking) while the page printed "＿＿".
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t他\n2\t们\n初等手写字表\n1\t他\n2\t们\n'),
    parseFrequency('1\t他\n2\t们\n'),
  );
  const DICT_TM = createDictionary(
    parseCedict([
      '他 他 [ta1] /he; him/',
      '们 们 [men5] /plural marker for pronouns/',
      '他们 他们 [ta1 men5] /they/',
    ].join('\n')),
  );
  const EXAMPLES_TM = createExampleIndex([{ term: '他们', level: 1 }]);

  function tmDeps(over: Partial<CliDeps> = {}): CliDeps {
    return deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_TM,
      examples: () => EXAMPLES_TM,
      reviews: createReviewStore(join(stateDir, 'reviews.json')),
      skip: [],
      ...over,
    });
  }

  /** The recall-cue divs' inner text, in the document order they were rendered. */
  function printedCues(html: string): string[] {
    return [...html.matchAll(/<div class="rc-cue"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]!);
  }

  it('stores the same cue in the manifest that was actually printed', async () => {
    const d = tmDeps();
    // Day 1: drill both characters so they enter the recall pool.
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    // Day 2: both are due for recall together — the collision that exposes the bug.
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);

    const manifest = d.sheets.getSheet('2026-08-21')!;
    expect(manifest.recall).toBeDefined();
    expect(manifest.recall!.length).toBeGreaterThan(0);

    const calls = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } }).mock.calls;
    const html = calls.at(-1)![0];
    const printed = printedCues(html);

    expect(manifest.recall!.map((r) => r.cue)).toEqual(printed);
    // And concretely: neither stored cue leaks the OTHER row's answer.
    for (const row of manifest.recall!) {
      const other = row.char === '他' ? '们' : '他';
      expect(row.cue).not.toContain(other);
    }
  });

  // MINOR: `generate` is the only non-page path by which the day's recall answers reach a
  // human before the sheet is actually written on — printing them defeats the point of a
  // system whose whole design is "grade without asking Franco to look at the answer".
  it('reports only the recall count in text output, never the characters', async () => {
    const d = tmDeps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    out = [];
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);

    expect(text()).toMatch(/recall: 2/);
    expect(text()).not.toContain('他');
    expect(text()).not.toContain('们');
  });

  it('reports only the recall count in --json output, never the characters', async () => {
    const d = tmDeps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    out = [];
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21', '--json'], d);

    const parsed = JSON.parse(text()) as { recall: unknown; recallCount: number };
    expect(parsed.recallCount).toBe(2);
    expect(parsed.recall).toBeUndefined();
    expect(text()).not.toContain('他');
    expect(text()).not.toContain('们');
  });
});

describe('xiehanzi generate — recall regeneration is idempotent for an existing date', () => {
  // CRITICAL: planRecall re-derives the due set from the CURRENT review log on every call,
  // while planSheet's drill half short-circuits entirely for a date already on record. A
  // review appended between two `generate` calls for the same date must not change what the
  // manifest says was asked — the device already holds a sheet printed with the original set.
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t他\n2\t们\n初等手写字表\n1\t他\n2\t们\n'),
    parseFrequency('1\t他\n2\t们\n'),
  );
  const DICT_TM = createDictionary(
    parseCedict([
      '他 他 [ta1] /he; him/',
      '们 们 [men5] /plural marker for pronouns/',
    ].join('\n')),
  );

  function tmDeps(over: Partial<CliDeps> = {}): CliDeps {
    return deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_TM,
      examples: () => createExampleIndex([]),
      reviews: createReviewStore(join(stateDir, 'reviews.json')),
      skip: [],
      ...over,
    });
  }

  async function drillThenRecall(d: CliDeps) {
    // Day 1: drill both characters so they enter the recall pool.
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    // Day 2: both are due for recall — the manifest records 2 rows.
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    return d.sheets.getSheet('2026-08-21')!;
  }

  it('leaves manifest.recall unchanged when a later review would shrink the due set', async () => {
    const d = tmDeps();
    const first = await drillThenRecall(d);
    expect(first.recall).toHaveLength(2);

    // A review appended after generating for 2026-08-21 would, on replay, push 他 out to
    // 2026-08-24 — no longer due on the 21st, so a recompute would drop it from the set.
    d.reviews.append([{ date: '2026-08-21', char: '他', result: 'pass', evidence: 'ink' }]);

    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    const second = d.sheets.getSheet('2026-08-21')!;

    expect(second.recall).toEqual(first.recall);
    expect(second.recallGeometry).toEqual(first.recallGeometry);
  });

  it('leaves manifest.recall unchanged even when the recomputed set would be empty', async () => {
    const d = tmDeps();
    const first = await drillThenRecall(d);
    expect(first.recall).toHaveLength(2);

    // Both characters pass, so a recompute for 2026-08-21 would find NOTHING due — the
    // buggy code's `recallRows.length === 0 ? {} : {...}` would then strip recall and
    // recallGeometry from the manifest entirely.
    d.reviews.append([
      { date: '2026-08-21', char: '他', result: 'pass', evidence: 'ink' },
      { date: '2026-08-21', char: '们', result: 'pass', evidence: 'ink' },
    ]);

    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    const second = d.sheets.getSheet('2026-08-21')!;

    expect(second.recall).toEqual(first.recall);
    expect(second.recallGeometry).toEqual(first.recallGeometry);
  });

  // ROOT CAUSE: planSheet's saveSheet call is a wholesale replace that drops recall and
  // recallGeometry — harmless for a plain re-run, because planSheet's drill half short-
  // circuits before touching the store. But --force skips that short-circuit, so the drill
  // half recomputes AND calls saveSheet, wiping recall out from under the guard that reads
  // getSheet() afterwards. The guard must instead be driven by what the manifest held
  // BEFORE planSheet ran.
  it('--force leaves manifest.recall and recallGeometry unchanged, even when the review log has since changed', async () => {
    const d = tmDeps();
    const first = await drillThenRecall(d);
    expect(first.recall).toHaveLength(2);

    // Same review this suite already uses to prove a recompute would differ — here forcing
    // a rebuild of the drill half must not let it leak into recall either.
    d.reviews.append([{ date: '2026-08-21', char: '他', result: 'pass', evidence: 'ink' }]);

    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21', '--force'], d);
    const second = d.sheets.getSheet('2026-08-21')!;

    expect(second.recall).toEqual(first.recall);
    expect(second.recallGeometry).toEqual(first.recallGeometry);
  });

  // Guard against over-correcting into never computing recall at all: the very first
  // generation for a date with due items must still get recall rows.
  it('still computes and stores recall on the genuine first generation for a date', async () => {
    const d = tmDeps();
    const first = await drillThenRecall(d);
    expect(first.recall).toHaveLength(2);
    expect(first.recallGeometry).toBeDefined();
  });
});

describe('xiehanzi generate — a reprint uses the geometry the manifest records', () => {
  // The manifest is the record grading maps ink onto. Until the pitch and the first-cell
  // gap changed, freshly computed geometry happened to equal the stored geometry and
  // rendering with either produced the same page. Now they differ, and a reprint drawn
  // with today's numbers against yesterday's manifest would score ink against rows that
  // are not where the manifest says they are.
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t他\n2\t们\n初等手写字表\n1\t他\n2\t们\n'),
    parseFrequency('1\t他\n2\t们\n'),
  );
  const DICT_TM = createDictionary(
    parseCedict(['他 他 [ta1] /he; him/', '们 们 [men5] /plural marker for pronouns/'].join('\n')),
  );

  function tmDeps(): CliDeps {
    return deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_TM,
      examples: () => createExampleIndex([]),
      reviews: createReviewStore(join(stateDir, 'reviews.json')),
      skip: [],
    });
  }

  const lastHtml = (d: CliDeps): string =>
    (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } }).mock.calls.at(-1)![0];

  const topsOf = (html: string, cls: string): number[] =>
    [...html.matchAll(new RegExp(`class="${cls}" style="[^"]*top:([\\d.]+)mm`, 'g'))].map((m) => Number(m[1]));

  const leftsOf = (html: string, cls: string): number[] =>
    [...html.matchAll(new RegExp(`class="${cls}" style="left:([\\d.]+)mm`, 'g'))].map((m) => Number(m[1]));

  /** An older layout: the minimum pitch, and no first-cell gap — the shape on disk today. */
  const OLDER = { cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 10 };

  async function sheetPrintedWithOlderGeometry(d: CliDeps) {
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    const stored = d.sheets.getSheet('2026-08-21')!;
    expect(stored.recall).toHaveLength(2);
    // Rewrite history to what a sheet printed before this change actually carries.
    d.sheets.saveSheet({
      date: stored.date,
      characters: stored.characters,
      recall: stored.recall!,
      recallGeometry: OLDER,
    });
    out = [];
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    return lastHtml(d);
  }

  it('reprints the rows at the pitch the manifest records, not the current one', async () => {
    const html = await sheetPrintedWithOlderGeometry(tmDeps());
    expect(topsOf(html, 'rc-cells')).toEqual([OLDER.originYMm, OLDER.originYMm + OLDER.rowPitchMm]);
  });

  it('reprints without a first-cell gap the manifest never had', async () => {
    const html = await sheetPrintedWithOlderGeometry(tmDeps());
    expect(leftsOf(html, 'rc-cells')).toEqual([
      OLDER.originXMm + OLDER.cellMm, OLDER.originXMm + OLDER.cellMm,
    ]);
  });

  it('aligns the reprinted answers page with the manifest too', async () => {
    const html = await sheetPrintedWithOlderGeometry(tmDeps());
    expect(topsOf(html, 'sol-glyph')).toEqual([OLDER.originYMm, OLDER.originYMm + OLDER.rowPitchMm]);
  });

  it('leaves the stored geometry untouched by the reprint', async () => {
    const d = tmDeps();
    await sheetPrintedWithOlderGeometry(d);
    expect(d.sheets.getSheet('2026-08-21')!.recallGeometry).toEqual(OLDER);
  });
});

describe('xiehanzi generate — a date cannot gain recall it never had', () => {
  // ROOT CAUSE (second failure): a sheet whose first generation had nothing due gets no
  // `recall` on its manifest, and the delivered page has no recall section. planSheet's
  // drill half short-circuits on a plain re-run (nothing to force), so it never touches the
  // store — but the OLD guard read getSheet() only, saw no recall, and treated that as "go
  // compute it fresh", finding items that have since become due and writing rows into a
  // manifest for a page that was never printed with a recall section. Grading then maps
  // recall geometry onto page 0 — a DRILL page — and reads drill ink as recall answers.
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t他\n2\t们\n初等手写字表\n1\t他\n2\t们\n'),
    parseFrequency('1\t他\n2\t们\n'),
  );
  const DICT_TM = createDictionary(
    parseCedict([
      '他 他 [ta1] /he; him/',
      '们 们 [men5] /plural marker for pronouns/',
    ].join('\n')),
  );

  function tmDeps(over: Partial<CliDeps> = {}): CliDeps {
    return deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_TM,
      examples: () => createExampleIndex([]),
      reviews: createReviewStore(join(stateDir, 'reviews.json')),
      skip: [],
      ...over,
    });
  }

  it('stays recall-free on a later re-run even once items have become due', async () => {
    const d = tmDeps();

    // First-ever generation for this date: 他/们 are introduced by THIS sheet, so neither
    // is due for recall the same day it is taught. The manifest carries no recall at all.
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    const first = d.sheets.getSheet('2026-08-21')!;
    expect(first.recall).toBeUndefined();
    expect(first.recallGeometry).toBeUndefined();

    // Backdate an introduction to 2026-08-10 — 11 days before the sheet's date — so a
    // recompute for 2026-08-21 would find both characters well overdue for recall. This
    // stands in for "time has passed and items have become due" without touching the clock.
    d.sheets.saveSheet({
      date: '2026-08-10',
      characters: [
        { char: '他', reason: 'linear' },
        { char: '们', reason: 'linear' },
      ],
    });

    out = [];
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    const second = d.sheets.getSheet('2026-08-21')!;

    // The delivered page for 08-21 never had a recall section — the manifest must keep
    // saying so, not retroactively claim rows that were never printed.
    expect(second.recall).toBeUndefined();
    expect(second.recallGeometry).toBeUndefined();
    expect(second.characters).toEqual(first.characters);
    expect(text()).not.toMatch(/recall: [1-9]/);
  });
});

describe('xiehanzi push — refusing is not failing', () => {
  // The morning job re-runs after a day's practice and finds the device copy changed.
  // Alarming on that trains you to ignore the channel.
  it('exits zero when it leaves written-on work alone', async () => {
    const d = deps();
    const written = join(stateDir, 'written.note');
    writeFileSync(written, 'a sheet');

    const cloud = {
      login: vi.fn(async () => 't'),
      useToken: vi.fn(),
      listDirectory: vi.fn(async () => []),
      ensureDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async () => ({
        id: 'f', directoryId: 'dir', fileName: 'written.note',
        isFolder: false, md5: 'something-else', size: 9, updateTime: 1,
      })),
      uploadFile: vi.fn(async () => ({ md5: 'x' })),
      deleteEntry: vi.fn(async () => {}),
      renameEntry: vi.fn(async () => {}),
      revertDelete: vi.fn(async () => {}),
      requestVerification: vi.fn(),
      verify: vi.fn(),
    };
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));

    const code = await run(['push', `--file=${written}`], { ...d, cloud: () => cloud as never });

    expect(code).toBe(0);
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
    expect(text()).toMatch(/left alone/i);
  });
});

describe('xiehanzi push --replace', () => {
  // A replacement must leave a copy of what it overwrote on disk before the cloud changes.
  it('keeps the previous copy locally, then replaces', async () => {
    const d = deps();
    const sheet = join(stateDir, 'sheet.note');
    writeFileSync(sheet, 'a new sheet');
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));

    const files = new Map<string, { id: string; directoryId: string; fileName: string; isFolder: boolean; md5: string; size: number; updateTime: number }>();
    files.set('sheet.note', { id: 'f1', directoryId: 'dir', fileName: 'sheet.note', isFolder: false, md5: 'deadbeef', size: 9, updateTime: 1 });
    const cloud = {
      login: vi.fn(async () => 't'),
      useToken: vi.fn(),
      listDirectory: vi.fn(async () => [...files.values()]),
      ensureDirectory: vi.fn(async () => 'dir'),
      resolveDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async (_d: string, name: string) => files.get(name)),
      downloadFile: vi.fn(async () => Buffer.from('his handwriting')),
      uploadFile: vi.fn(async (directoryId: string, fileName: string, bytes: Buffer) => {
        const md5 = createHash('md5').update(bytes).digest('hex');
        files.set(fileName, { id: 'f2', directoryId, fileName, isFolder: false, md5, size: bytes.length, updateTime: 2 });
        return { md5 };
      }),
      deleteEntry: vi.fn(async (e: { fileName: string }) => { files.delete(e.fileName); }),
      renameEntry: vi.fn(async (e: { fileName: string }, n: string) => {
        const entry = files.get(e.fileName)!;
        files.delete(e.fileName);
        files.set(n, { ...entry, fileName: n });
      }),
      revertDelete: vi.fn(async () => {}),
      requestVerification: vi.fn(),
      verify: vi.fn(),
    };

    const code = await run(['push', `--file=${sheet}`, '--replace'], { ...d, cloud: () => cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/Replaced sheet\.note/);
    const keptDir = join(stateDir, 'replaced');
    const kept = readdirSync(keptDir);
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(keptDir, kept[0]!), 'utf8')).toBe('his handwriting');
    expect([...files.keys()]).toEqual(['sheet.note']);
  });
});

describe('xiehanzi push — dry run wording', () => {
  // The dry run used to answer "would upload" for every case, including the one where the
  // real run refuses to touch handwriting. That is the answer the operator came to check,
  // so each outcome has to read back conditionally and truthfully.

  function dryRunAgainst(remoteMd5: string, extra: string[] = []) {
    const d = deps();
    const sheet = join(stateDir, 'sheet.note');
    writeFileSync(sheet, 'a sheet');
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));

    const cloud = {
      login: vi.fn(async () => 't'),
      useToken: vi.fn(),
      listDirectory: vi.fn(async () => []),
      ensureDirectory: vi.fn(async () => 'dir'),
      resolveDirectory: vi.fn(async (): Promise<string | undefined> => 'dir'),
      findEntry: vi.fn(async () => ({
        id: 'f', directoryId: 'dir', fileName: 'sheet.note',
        isFolder: false, md5: remoteMd5, size: 9, updateTime: 1,
      })),
      uploadFile: vi.fn(async () => ({ md5: 'x' })),
      deleteEntry: vi.fn(async () => {}),
      renameEntry: vi.fn(async () => {}),
      revertDelete: vi.fn(async () => {}),
      requestVerification: vi.fn(),
      verify: vi.fn(),
    };

    return {
      cloud,
      run: () => run(['push', `--file=${sheet}`, '--dry-run', ...extra], { ...d, cloud: () => cloud as never }),
    };
  }

  const ourMd5 = createHash('md5').update(Buffer.from('a sheet')).digest('hex');

  it('says it would leave written-on work alone, not that it would upload', async () => {
    const { run: go, cloud } = dryRunAgainst('something-else');
    expect(await go()).toBe(0);

    expect(text()).toMatch(/DRY RUN/);
    expect(text()).toMatch(/would leave alone/i);
    expect(text()).not.toMatch(/would upload/i);
    // A dry run must not create the remote folder either.
    expect(cloud.ensureDirectory).not.toHaveBeenCalled();
    expect(cloud.uploadFile).not.toHaveBeenCalled();
    expect(cloud.deleteEntry).not.toHaveBeenCalled();
  });

  it('needs a session, because it has to look before it can answer', async () => {
    // Answering without looking is exactly how the old dry run came to promise an upload
    // for a sheet it would have refused to touch.
    const d = deps();
    const sheet = join(stateDir, 'sheet.note');
    writeFileSync(sheet, 'a sheet');
    // No session.json written on purpose.
    const code = await run(['push', `--file=${sheet}`, '--dry-run'], d);

    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/not signed in/i);
  });

  it('says it would replace when --replace is given', async () => {
    const { run: go } = dryRunAgainst('something-else', ['--replace']);
    await go();
    expect(text()).toMatch(/would replace/i);
  });

  it('says nothing would be uploaded when the file is already identical', async () => {
    const { run: go } = dryRunAgainst(ourMd5);
    await go();
    expect(text()).toMatch(/nothing would be uploaded/i);
  });
});

describe('xiehanzi grade', () => {
  const geometry = {
    cellMm: 12.5, originXMm: 14, originYMm: 15.4, rowPitchMm: 17.2, cellsPerRow: 6, rowsPerPage: 11,
  };

  it('exits 0 and never touches the cloud when there is no manifest for the date', async () => {
    const cloud = vi.fn(() => { throw new Error('cloud should not have been touched'); });

    const code = await run(['grade', '--date=2026-01-01'], deps({ cloud: cloud as never }));

    expect(code).toBe(0);
    expect(text()).toMatch(/no sheet/i);
    expect(cloud).not.toHaveBeenCalled();
  });

  // Distinct from no manifest at all: a sheet generated before recall existed, or one
  // whose recall capacity was zero that day. The code treats both the same way, but
  // nothing proved it until now.
  it('exits 0 and never touches the cloud for a manifest with no recall geometry', async () => {
    const d = deps();
    d.sheets.saveSheet({ date: '2026-08-22', characters: [{ char: '市', reason: 'linear' }] });
    const cloud = vi.fn(() => { throw new Error('cloud should not have been touched'); });

    const code = await run(['grade', '--date=2026-08-22'], { ...d, cloud: cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/no sheet/i);
    expect(cloud).not.toHaveBeenCalled();
  });

  // The message must distinguish "not on the cloud at all" (a stuck push, a broken sync —
  // a real problem worth someone noticing) from "on the cloud but unwritten" (an ordinary
  // skipped morning), so the two can never read the same in the logs.
  it('reports a distinct message when the sheet is not on the cloud at all', async () => {
    const d = deps();
    d.sheets.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '市', reason: 'linear' }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
      recallGeometry: geometry,
    });
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));
    const cloud = {
      login: vi.fn(async () => 't'), useToken: vi.fn(),
      ensureDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async () => undefined),
      downloadFile: vi.fn(async () => { throw new Error('should not download when the file is absent'); }),
      requestVerification: vi.fn(), verify: vi.fn(),
    };

    const code = await run(['grade', '--date=2026-08-22'], { ...d, cloud: () => cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/not on supernote cloud/i);
    expect(text()).not.toMatch(/not been written on/i);
    expect(cloud.downloadFile).not.toHaveBeenCalled();
  });

  // "Has not been written on yet" is true of a device that never uploaded and of a day
  // Franco took off, and those need opposite responses. The stamp is the only thing in
  // reach that separates them, so it has to reach the log — on 2026-09-23 the upload had
  // to be dated from a *backup job's* log instead, because this line threw it away.
  it('says when the cloud copy was last updated on a sheet that was not written on', async () => {
    const d = deps();
    d.sheets.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '市', reason: 'linear' }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
      recallGeometry: geometry,
    });
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));
    const cloud = {
      login: vi.fn(async () => 't'), useToken: vi.fn(),
      ensureDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async () => ({
        id: 'f', directoryId: 'dir', fileName: '2026-08-22 写汉字.note',
        isFolder: false, md5: '', size: 1, updateTime: Date.UTC(2026, 7, 22, 4, 20, 9),
      })),
      downloadFile: vi.fn(async () => writeNote([{ background: blankLayer(1920, 2560) }], { seed: 'no-ink' })),
      requestVerification: vi.fn(), verify: vi.fn(),
    };

    const code = await run(['grade', '--date=2026-08-22'], { ...d, cloud: () => cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/not been written on/i);
    expect(text()).toMatch(/2026-08-22T04:20:09/);
  });

  // Requirement 1 (idempotence) asked for proof that a dry run cannot be used to sneak
  // past the already-graded guard. Until now that rested on reading the code.
  it('a dry run cannot bypass idempotence for an already-graded date', async () => {
    const d = deps();
    d.sheets.saveSheet({
      date: '2026-08-22',
      characters: [{ char: '市', reason: 'linear' }],
      recall: [{ char: '市', cue: '…', page: 0, row: 0 }],
      recallGeometry: geometry,
    });
    d.reviews.append([{ date: '2026-08-22', char: '市', result: 'pass', evidence: 'ink' }]);
    const cloud = vi.fn(() => { throw new Error('cloud should not have been touched'); });

    const code = await run(['grade', '--date=2026-08-22', '--dry-run'], { ...d, cloud: cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/already graded/i);
    expect(d.reviews.all()).toHaveLength(1);
    expect(cloud).not.toHaveBeenCalled();
  });
});

describe('xiehanzi glossary', () => {
  const notes = [
    { fields: { Hanzi: { value: '老' }, Definition: { value: 'old; aged' }, Pinyin: { value: 'lǎo' } } },
    { fields: { Hanzi: { value: '着' }, Definition: { value: 'in process of' }, Pinyin: { value: 'zhe' } } },
  ];

  function glossaryDeps(over: Partial<CliDeps> = {}): CliDeps {
    const anki = {
      invoke: vi.fn(async (action: string) => (action === 'notesInfo' ? notes : null)),
      deckNames: async () => [],
      modelNames: async () => [],
      findNotes: vi.fn(async () => [1, 2]),
      findCards: async () => [],
    } as unknown as AnkiClient;
    return deps({ anki: () => anki, ...over });
  }

  it('writes the file and reports what it wrote', async () => {
    const d = glossaryDeps();
    expect(await run(['glossary'], d)).toBe(0);
    expect(loadGlossary(d.glossaryPath).define('老')).toBe('old; aged');
    expect(text()).toMatch(/2/);
  });

  it('reports how many entries changed, not just how many exist', async () => {
    const d = glossaryDeps();
    await run(['glossary'], d);
    out = [];
    await run(['glossary'], d);
    // Nothing moved between the two runs, so nothing changed.
    expect(text()).toMatch(/0 changed|no change/i);
  });

  it('writes nothing at all on a dry run', async () => {
    const d = glossaryDeps();
    expect(await run(['glossary', '--dry-run'], d)).toBe(0);
    expect(existsSync(d.glossaryPath)).toBe(false);
    expect(out[0]).toMatch(/dry run/i);
  });

  it('still reports what a dry run would have written', async () => {
    const d = glossaryDeps();
    await run(['glossary', '--dry-run'], d);
    expect(text()).toMatch(/2/);
  });

  // The scheduled job runs on a machine with no Anki at all. A refresh there has to fail
  // with something Franco can act on, not a bare "fetch failed".
  it('fails cleanly when Anki is not reachable', async () => {
    const anki = {
      invoke: vi.fn(async () => null),
      deckNames: async () => [],
      modelNames: async () => [],
      findNotes: vi.fn(async () => {
        throw new AnkiUnreachableError('Could not reach Anki at http://127.0.0.1:8765.');
      }),
      findCards: async () => [],
    } as unknown as AnkiClient;
    const d = glossaryDeps({ anki: () => anki });

    expect(await run(['glossary'], d)).toBe(1);
    expect(err.join('')).toMatch(/anki/i);
    expect(existsSync(d.glossaryPath)).toBe(false);
  });

  it('emits JSON for an agent', async () => {
    const d = glossaryDeps();
    await run(['glossary', '--json'], d);
    expect(JSON.parse(text())).toMatchObject({ entries: 2, changed: 2, dryRun: false });
  });

  it('is documented in the usage text', async () => {
    await run(['--help'], deps());
    expect(text()).toMatch(/glossary/);
  });
});

describe('xiehanzi generate — the printed gloss is the one Franco studied', () => {
  // CC-CEDICT leads 老 with "prefix used before the surname of a person", which is correct
  // and is not what he learned. His own deck says "old; aged".
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t老\n初等手写字表\n1\t老\n'),
    parseFrequency('1\t老\n'),
  );
  const DICT_LAO = createDictionary(
    parseCedict(['老 老 [lao3] /prefix used before the surname of a person/old/'].join('\n')),
  );

  it('prints the studied definition on the sheet', async () => {
    const d = deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_LAO,
      examples: () => createExampleIndex([]),
      glossary: () => createGlossary({ 老: { definition: 'old; aged', pinyin: 'lǎo' } }),
      skip: [],
    });
    await run(['generate', '--count=1', '--review=0', '--date=2026-08-20'], d);
    const html = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } })
      .mock.calls.at(-1)![0];
    expect(html).toContain('old; aged');
    expect(html).not.toContain('prefix used before the surname');
  });
});

// CRITICAL: interleaving the answers pages moved the recall pages from physical page 0 and
// 1 of the .note to 0 and 2. `RecallRow.page` is a physical page index — grading indexes
// note.pages with it directly — so a row builder that kept counting recall pages would send
// the evening job to score page 1, which is now an ANSWERS page: no ink anywhere, every row
// on it recorded as never attempted, and the second page's real attempts never graded at
// all. This walks the actual rendered document rather than asserting on the arithmetic.
describe('xiehanzi generate — manifest page indexes point at the printed recall pages', () => {
  const CHARS = [...'他们你我的是不了在有个中人大'];
  const CATALOGUE = createCatalogue(
    parseCharList(
      `一级汉字表\n${CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')}\n` +
        `初等手写字表\n${CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')}\n`,
    ),
    parseFrequency(CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')),
  );
  const DICT_MANY = createDictionary(
    parseCedict(CHARS.map((c) => `${c} ${c} [ta1] /a gloss for ${c}/`).join('\n')),
  );

  /** Every `<div class="page …">` of the document, in order. */
  const pagesOf = (html: string): string[] => html.split('<div class="page ').slice(1);

  async function twoPageSheet() {
    const d = deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_MANY,
      examples: () => createExampleIndex([]),
      skip: [],
    });
    // Day 1 drills every character, so day 2 has all of them due for recall at once —
    // more than fit on one recall page.
    await run([`generate`, `--count=${CHARS.length}`, '--review=0', '--date=2026-08-20'], d);
    await run([`generate`, `--count=${CHARS.length}`, '--review=0', '--date=2026-08-21'], d);
    const html = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } })
      .mock.calls.at(-1)![0];
    return { manifest: d.sheets.getSheet('2026-08-21')!, html };
  }

  it('spans more than one recall page, or this proves nothing', async () => {
    const { manifest } = await twoPageSheet();
    expect(new Set(manifest.recall!.map((r) => r.page)).size).toBeGreaterThan(1);
  });

  it('records the page each row was actually printed on', async () => {
    const { manifest, html } = await twoPageSheet();
    const pages = pagesOf(html);
    for (const row of manifest.recall!) {
      expect(`${row.char} on page ${row.page}: ${pages[row.page]?.slice(0, 7)}`)
        .toBe(`${row.char} on page ${row.page}: rc-page`);
      expect(pages[row.page]).toContain(row.cue);
    }
  });

  it('never points a row at an answers page', async () => {
    const { manifest, html } = await twoPageSheet();
    const pages = pagesOf(html);
    for (const row of manifest.recall!) {
      expect(pages[row.page]!.startsWith('sol-page')).toBe(false);
    }
  });

  // Concretely: the second recall page is physical page 2, not page 1.
  it('puts the second recall page at index 2, with the answers page between', async () => {
    const { manifest } = await twoPageSheet();
    expect([...new Set(manifest.recall!.map((r) => r.page))].sort((a, b) => a - b)).toEqual([0, 2]);
  });
});

// The whole loop, both CLI halves, on a sheet whose recall spills onto a second page:
// `generate` decides what is asked and writes the manifest, the interleaved document
// decides which physical page each recall page lands on, and `grade` reads ink off that
// document and has to score it against the character the manifest recorded for that page.
//
// This is the test that would have caught the interleave going in unaccompanied. With the
// old `page = recall page index`, page 1 is now the ANSWERS page — blank, so every row on
// it records nothing — and the real second page of attempts is never looked at.
describe('xiehanzi generate then grade — a two-recall-page sheet, end to end', () => {
  const CHARS = [...'他们你我的是不了在有个中人大'];
  const CATALOGUE = createCatalogue(
    parseCharList(
      `一级汉字表\n${CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')}\n` +
        `初等手写字表\n${CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')}\n`,
    ),
    parseFrequency(CHARS.map((c, i) => `${i + 1}\t${c}`).join('\n')),
  );
  const DICT_MANY = createDictionary(
    parseCedict(CHARS.map((c) => `${c} ${c} [ta1] /a gloss for ${c}/`).join('\n')),
  );

  const PX_W = 1920, PX_H = 2560;
  const W_MM = DEFAULT_SHEET_CONFIG.pageWidthMm, H_MM = DEFAULT_SHEET_CONFIG.pageHeightMm;

  /** A writing layer whose only ink fills the graded first cell of the given rows. */
  function inkInRows(geometry: RecallGeometry, rows: readonly number[]): Buffer {
    const pixels = new Uint8Array(PX_W * PX_H).fill(RLE.background);
    for (const row of rows) {
      const r = cellRect(geometry, row, 0);
      const x0 = Math.round((r.xMm / W_MM) * PX_W);
      const x1 = Math.round(((r.xMm + r.widthMm) / W_MM) * PX_W);
      const y0 = Math.round((r.yMm / H_MM) * PX_H);
      const y1 = Math.round(((r.yMm + r.heightMm) / H_MM) * PX_H);
      for (let y = y0; y < y1; y += 1) pixels.fill(RLE.black, y * PX_W + x0, y * PX_W + x1);
    }
    return encodeRle(pixels);
  }

  /**
   * Generates 2026-08-21, then writes on it exactly as Franco would: one row on each of the
   * two recall pages, at deliberately different row indices so a page mix-up cannot land on
   * an inked cell by luck. Every other page of the note — the two answers pages and the
   * drill pages — is left blank, because they are not written on.
   */
  async function generateAndWriteOn(inked: readonly [page: number, row: number][]) {
    const d = deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_MANY,
      examples: () => createExampleIndex([]),
      skip: [],
    });
    await run([`generate`, `--count=${CHARS.length}`, '--review=0', '--date=2026-08-20'], d);
    await run([`generate`, `--count=${CHARS.length}`, '--review=0', '--date=2026-08-21'], d);

    const manifest = d.sheets.getSheet('2026-08-21')!;
    const html = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } })
      .mock.calls.at(-1)![0];
    const pageCount = (html.match(/class="page /g) ?? []).length;

    const inkByPage = new Map<number, number[]>();
    for (const [page, row] of inked) inkByPage.set(page, [...(inkByPage.get(page) ?? []), row]);

    const bytes = writeNote(
      Array.from({ length: pageCount }, (_, i) => {
        const rows = inkByPage.get(i);
        return {
          background: blankLayer(PX_W, PX_H),
          ...(rows === undefined ? {} : { writing: inkInRows(manifest.recallGeometry!, rows) }),
        };
      }),
      { seed: 'cli-e2e' },
    );

    const entry: CloudEntry = {
      id: 'f1', directoryId: 'd1', fileName: '2026-08-21 写汉字.note',
      isFolder: false, md5: '', size: bytes.length, updateTime: 1,
    };
    const cloud = {
      login: async () => 'token',
      listDirectory: async () => [entry],
      ensureDirectory: async () => 'd1',
      resolveDirectory: async () => 'd1',
      findEntry: async () => entry,
      uploadFile: async () => ({ md5: '' }),
      deleteEntry: async () => {},
      downloadFile: async () => bytes,
      requestVerification: async () => ({ email: 'a@b.c', timestamp: 1, validCodeKey: 'k' }),
      verify: async () => 'token',
      useToken: () => {},
    } as unknown as SupernoteCloud;

    // Grading reads a cell only through the recognisers, and this test is about which cells
    // get read, not how. So both read each inked cell as the character printed for it: cells
    // are recognised one at a time, page by page and row by row, so a queue in that order
    // lines up. A page mix-up would grade a blank cell, which is never recognised at all.
    const answers = [...inked]
      .sort(([p1, r1], [p2, r2]) => p1 - p2 || r1 - r2)
      // Ink on an answers page has no recall row, and is never recognised.
      .flatMap(([page, row]) => manifest.recall!.filter((r) => r.page === page && r.row === row).map((r) => r.char));
    let lastRead = '';
    const recognisers: Recognisers = {
      google: { name: 'google', recognise: async () => ({ source: 'google', candidates: [(lastRead = answers.shift() ?? '')] }) },
      partner: { name: 'go:test', recognise: async () => ({ source: 'go:test', candidates: [lastRead] }) },
    };

    writeFileSync(d.sessionPath, JSON.stringify({ token: 't', account: 'a', savedAt: 'now' }));
    const graded = deps({
      sheets: d.sheets, reviews: d.reviews, cloud: () => cloud, sessionPath: d.sessionPath,
      recognisers: () => recognisers,
    });
    expect(await run(['grade', '--date=2026-08-21'], graded)).toBe(0);
    return { manifest, reviews: graded.reviews.all(), pageCount };
  }

  it('renders recall, answers, recall, answers and then the drill pages', async () => {
    const { pageCount, manifest } = await generateAndWriteOn([]);
    expect(manifest.recall!.some((r) => r.page === 2)).toBe(true);
    expect(pageCount).toBeGreaterThan(4);
  });

  it('grades the ink on each recall page against the characters printed there', async () => {
    // Row 0 of the first recall page, row 2 of the second. Different indices on purpose:
    // grading page 2's rows against page 0's pixels would land on a blank cell.
    const { manifest, reviews } = await generateAndWriteOn([[0, 0], [2, 2]]);

    const expected = [
      manifest.recall!.find((r) => r.page === 0 && r.row === 0)!.char,
      manifest.recall!.find((r) => r.page === 2 && r.row === 2)!.char,
    ];
    expect(reviews.map((r) => r.char).sort()).toEqual([...expected].sort());
    expect(reviews.every((r) => r.result === 'pass')).toBe(true);
  });

  it('grades the second recall page at all, rather than silently reading a blank answers page', async () => {
    const { reviews } = await generateAndWriteOn([[2, 2]]);
    expect(reviews).toHaveLength(1);
  });

  // Ink Franco leaves on an answers page — a correction written beside the printed answer —
  // is not an attempt and must never become a verdict.
  it('records nothing from ink that lands on an answers page', async () => {
    const { reviews } = await generateAndWriteOn([[1, 0]]);
    expect(reviews).toEqual([]);
  });
});

// A sheet printed before the answers pages were interleaved is on the device with its
// recall on physical pages 0 and 1, and its manifest says so. Re-running `generate` for
// that date reprints the page — and a reprint that silently adopted today's order would
// move the recall pages to 0 and 2 while the manifest still said 0 and 1, which is the
// same corruption as reprinting with today's geometry against yesterday's manifest.
describe('xiehanzi generate — reprinting a date from before the interleave', () => {
  const STACKED_GEOMETRY: RecallGeometry = {
    cellMm: 12.499999999999998, originXMm: 14, originYMm: 15.4, rowPitchMm: 18.77,
    cellsPerRow: 6, rowsPerPage: 11, firstCellGapMm: 2.5,
  };

  /** Twelve rows against an 11-row page: eleven on the first recall page, one on the second. */
  async function reprint(secondPage: number) {
    const chars = [...'他们你我的是不了在有个中'];
    const d = deps({ skip: [] });
    d.sheets.saveSheet({
      date: '2026-08-28',
      characters: chars.map((char) => ({ char, reason: 'linear' as const })),
      recall: chars.map((char, i) => ({
        char,
        cue: `cue ${i}`,
        page: i < STACKED_GEOMETRY.rowsPerPage ? 0 : secondPage,
        row: i % STACKED_GEOMETRY.rowsPerPage,
      })),
      recallGeometry: STACKED_GEOMETRY,
    });
    await run(['generate', '--date=2026-08-28'], d);
    const html = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } })
      .mock.calls.at(-1)![0];
    return { manifest: d.sheets.getSheet('2026-08-28')!, html };
  }

  const kinds = (html: string) => [...html.matchAll(/class="page ([\w-]+)"/g)].map((m) => m[1]!);

  it('reprints consecutive recall pages in the order that sheet was printed', async () => {
    const { html } = await reprint(1);
    expect(kinds(html).slice(0, 4)).toEqual(['rc-page', 'rc-page', 'sol-page', 'sol-page']);
  });

  it('leaves the manifest\'s page indexes pointing at recall pages', async () => {
    const { manifest, html } = await reprint(1);
    const pages = html.split('<div class="page ').slice(1);
    for (const row of manifest.recall!) {
      expect(pages[row.page]!.slice(0, 7)).toBe('rc-page');
    }
  });

  it('reprints a manifest already written under the interleave with the interleave', async () => {
    const { html } = await reprint(2);
    expect(kinds(html).slice(0, 4)).toEqual(['rc-page', 'sol-page', 'rc-page', 'sol-page']);
  });
});

// 负 and 责 both come from 负责: on a day both are due, both rows blank to "＿＿ fùzé" and
// buildCues has to drop both example words for the bare characters. Choosing an example
// that names no other answer keeps the word cue, which is the better one.
describe('xiehanzi generate — recall examples avoid the sheet\'s other answers', () => {
  const CATALOGUE = createCatalogue(
    parseCharList('一级汉字表\n1\t负\n2\t责\n初等手写字表\n1\t负\n2\t责\n'),
    parseFrequency('1\t负\n2\t责\n'),
  );
  const DICT_FZ = createDictionary(
    parseCedict([
      '負 负 [fu4] /to bear/',
      '責 责 [ze2] /duty/',
      '負責 负责 [fu4 ze2] /to be responsible for/',
      '負擔 负担 [fu4 dan1] /burden/',
      '責任 责任 [ze2 ren4] /responsibility/',
    ].join('\n')),
  );
  const EXAMPLES_FZ = createExampleIndex([
    { term: '负责', level: 1 },
    { term: '负担', level: 4 },
    { term: '责任', level: 4 },
  ]);

  function fzDeps(over: Partial<CliDeps> = {}): CliDeps {
    return deps({
      catalogue: () => CATALOGUE,
      dictionary: () => DICT_FZ,
      examples: () => EXAMPLES_FZ,
      skip: [],
      ...over,
    });
  }

  async function cuesFor(): Promise<string[]> {
    const d = fzDeps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-21'], d);
    return d.sheets.getSheet('2026-08-21')!.recall!.map((r) => r.cue);
  }

  it('cues each row with a word the other row does not answer', async () => {
    // 负责 is the easiest word for both rows, and blanks to "＿＿ fùzé" for both. 负担 and
    // 责任 each name only their own row's answer.
    const cues = await cuesFor();
    expect(cues.some((c) => c.includes('＿担'))).toBe(true);
    expect(cues.some((c) => c.includes('＿任'))).toBe(true);
    expect(cues.some((c) => c.includes('zé</b>rèn') || c.includes('rèn'))).toBe(true);
  });

  it('leaves exactly one blank in each cue, not two', async () => {
    // "＿＿ fùzé" blanks the whole word because the other row's answer is the other half of
    // it. A term that names no other answer leaves the rest of the word standing.
    for (const cue of await cuesFor()) {
      expect((cue.match(/＿/g) ?? []).length).toBe(1);
    }
  });

  it('still leaks neither answer', async () => {
    for (const cue of await cuesFor()) {
      expect(cue).not.toContain('负');
      expect(cue).not.toContain('责');
    }
  });

  // A drill row prints its own model character, so an example naming another drill
  // character gives nothing away — and narrowing the choice there would only make the
  // examples worse.
  it('leaves the drill sheet\'s example choice alone', async () => {
    const d = fzDeps();
    await run(['generate', '--count=2', '--review=0', '--date=2026-08-20'], d);
    const html = (d.writeNoteFile as unknown as { mock: { calls: [string, string, string][] } })
      .mock.calls.at(-1)![0];
    // 负责 is the easiest word for both, and stays the drill example for both.
    expect(html.match(/负责/g)?.length).toBe(2);
  });
});

describe('regrade', () => {
  // The geometry every sheet since 2026-08-24 was printed with: cell 1 set apart by a gap,
  // so the crop margin around cell 0 cannot reach the correction ink.
  const GAPPED: RecallGeometry = { ...RECALL_GEOMETRY, firstCellGapMm: 2.5 };

  const reader = (name: string, chars: string[]) => ({
    name, recognise: async () => ({ source: name, candidates: chars }),
  });
  const both = (chars: string[]): Recognisers => ({ google: reader('google', chars), partner: reader('go:grok-4.6', chars) });

  function regradeDeps(over: Partial<CliDeps> = {}): CliDeps {
    return deps({ now: () => new Date('2026-10-02T12:00:00'), recognisers: () => both(['二']), ...over });
  }

  /** A gapped recall sheet for `date`, with a legacy ink pass and the written note in the backup. */
  function seedLegacy(d: CliDeps, date: string, char = '一'): void {
    seedRecallSheet(d, date, [char], GAPPED);
    d.reviews.append([{ date, char, result: 'pass', evidence: 'ink' }]);
    writeBackupNote(d, date, [0], GAPPED);
  }

  it('lists the verdicts that would change, and records nothing on a dry run', async () => {
    const d = regradeDeps();
    seedLegacy(d, '2026-08-22');

    const code = await run(['regrade', '--from=2026-08-22', '--to=2026-08-22', '--dry-run'], d);

    expect(code).toBe(0);
    expect(text()).toMatch(/2026-08-22.*一 pass → fail/);
    expect(text()).toMatch(/1 pass → fail, 0 fail → pass; 0 skipped, 0 degraded, 0 errored/);
    expect(d.reviews.all()).toHaveLength(1);
  });

  it('appends a revision for each changed date on a real run', async () => {
    const d = regradeDeps();
    seedLegacy(d, '2026-08-22');

    await run(['regrade', '--from=2026-08-22', '--to=2026-08-22'], d);
    expect(d.reviews.latestForDate('2026-08-22')).toEqual([
      expect.objectContaining({ char: '一', result: 'fail', revision: 1 }),
    ]);
  });

  it('prints each changed character\'s next due date before and after', async () => {
    const d = regradeDeps();
    seedLegacy(d, '2026-08-22');

    await run(['regrade', '--from=2026-08-22', '--to=2026-08-22', '--dry-run'], d);
    // Introduced 08-22: the ink pass on 08-22 moved it to 08-25 (step 1, 3 days); as a
    // fail it is due again the next day.
    expect(text()).toMatch(/一 2026-08-25 → 2026-08-23/);
    expect(text()).toMatch(/Characters due today: \d+ before, \d+ after/);
  });

  it('includes due changes, skipped, degraded and errored dates in --json', async () => {
    const d = regradeDeps();
    seedLegacy(d, '2026-08-22');
    seedRecallSheet(d, '2026-08-23', ['城'], RECALL_GEOMETRY);

    const code = await run(['--json', 'regrade', '--from=2026-08-22', '--to=2026-08-23', '--dry-run'], d);
    const parsed = JSON.parse(text());

    expect(code).toBe(0);
    expect(parsed.dueChanges).toEqual([{ char: '一', before: '2026-08-25', after: '2026-08-23' }]);
    expect(parsed.skipped).toEqual([{ date: '2026-08-23', reason: 'no first-cell gap' }]);
    expect(parsed.degraded).toEqual([]);
    expect(parsed.errored).toEqual([]);
  });

  // Regrade reaches dates the nightly window never revisits, so a revision it writes
  // degraded would stay degraded forever.
  it.each([
    ['partner', { google: reader('google', ['成']), partner: null }],
    ['google', { google: null, partner: reader('go:grok-4.6', ['成']) }],
  ])('refuses to run when the %s recogniser is not configured', async (_name, recognisers) => {
    const d = regradeDeps({ recognisers: () => recognisers as Recognisers });
    seedLegacy(d, '2026-08-22');

    const code = await run(['regrade', '--from=2026-08-22', '--to=2026-08-22'], d);

    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/needs both recognisers/);
    expect(d.reviews.all()).toHaveLength(1);
  });

  it('defaults --to to yesterday, leaving today\'s sheet alone', async () => {
    const d = regradeDeps({ now: () => new Date('2026-08-23T12:00:00') });
    seedLegacy(d, '2026-08-22');
    seedLegacy(d, '2026-08-23');

    const code = await run(['regrade', '--from=2026-08-22'], d);

    expect(code).toBe(0);
    expect(d.reviews.latestForDate('2026-08-22')[0]).toMatchObject({ result: 'fail', revision: 1 });
    expect(d.reviews.latestForDate('2026-08-23')).toEqual([
      { date: '2026-08-23', char: '一', result: 'pass', evidence: 'ink' },
    ]);
  });

  it.each([
    ['--to=2026-10-02', /before today/],
    ['--to=2026-10-03', /before today/],
    ['--to=yesterday', /--to=YYYY-MM-DD/],
    ['--to=2026-08-21', /is after --to/],
  ])('rejects %s', async (to, message) => {
    const d = regradeDeps();
    seedLegacy(d, '2026-08-22');

    const code = await run(['regrade', '--from=2026-08-22', to], d);

    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(message);
    expect(d.reviews.all()).toHaveLength(1);
  });

  it('rejects a missing --from', async () => {
    const code = await run(['regrade'], regradeDeps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--from=YYYY-MM-DD/);
  });

  it('records an error for one date and carries on with the next', async () => {
    const d = regradeDeps();
    // No backup copy and no cloud session: this date throws.
    seedRecallSheet(d, '2026-08-21', ['城'], GAPPED);
    seedLegacy(d, '2026-08-22');

    const code = await run(['regrade', '--from=2026-08-21', '--to=2026-08-22'], d);

    expect(code).toBe(1);
    expect(text()).toMatch(/error\s+2026-08-21: cloud not configured in tests/);
    expect(d.reviews.latestForDate('2026-08-22')[0]).toMatchObject({ result: 'fail', revision: 1 });
    expect(text()).toMatch(/0 skipped, 0 degraded, 1 errored/);
  });

  it('names every skipped date with its reason, including a sheet with no first-cell gap', async () => {
    const d = regradeDeps();
    seedRecallSheet(d, '2026-08-21', ['城'], RECALL_GEOMETRY);
    writeBackupNote(d, '2026-08-21', [0], RECALL_GEOMETRY);
    seedRecallSheet(d, '2026-08-22', ['城'], GAPPED);
    writeBackupNote(d, '2026-08-22', [], GAPPED);

    const code = await run(['regrade', '--from=2026-08-21', '--to=2026-08-22', '--dry-run'], d);

    expect(code).toBe(0);
    expect(text()).toMatch(/skipped\s+2026-08-21: no first-cell gap/);
    expect(text()).toMatch(/skipped\s+2026-08-22: not-attempted/);
    expect(text()).toMatch(/2 skipped, 0 degraded, 0 errored/);
  });

  // With the partner off, Google and the stroke gate are the whole pipeline: a missing
  // partner degrades nothing, so there is nothing to refuse.
  it('runs with no partner when the partner is off, and nothing it writes is degraded', async () => {
    const d = regradeDeps({ partnerMode: 'off', recognisers: () => ({ google: reader('google', ['二']), partner: null }) });
    seedLegacy(d, '2026-08-22');

    const code = await run(['regrade', '--from=2026-08-22', '--to=2026-08-22'], d);

    expect(code).toBe(0);
    expect(d.reviews.latestForDate('2026-08-22')).toEqual([
      expect.objectContaining({ char: '一', result: 'fail', revision: 1 }),
    ]);
    expect(d.reviews.latestForDate('2026-08-22')[0]!.degraded).toBeUndefined();
  });

  it('still refuses without Google when the partner is off', async () => {
    const d = regradeDeps({ partnerMode: 'off', recognisers: () => ({ google: null, partner: null }) });
    seedLegacy(d, '2026-08-22');

    expect(await run(['regrade', '--from=2026-08-22', '--to=2026-08-22'], d)).toBe(1);
    expect(err.join('\n')).toMatch(/needs Google/);
    expect(d.reviews.all()).toHaveLength(1);
  });

  it('refuses with no partner when the partner is asked about ambiguous cells', async () => {
    const d = regradeDeps({ partnerMode: 'ambiguous', recognisers: () => ({ google: reader('google', ['二']), partner: null }) });
    seedLegacy(d, '2026-08-22');

    expect(await run(['regrade', '--from=2026-08-22', '--to=2026-08-22'], d)).toBe(1);
    expect(err.join('\n')).toMatch(/needs both recognisers/);
    expect(d.reviews.all()).toHaveLength(1);
  });

  it('names a degraded date even when nothing on it changed, and exits 1', async () => {
    const d = regradeDeps({
      recognisers: () => ({
        google: reader('google', ['城']),
        partner: { name: 'go:grok-4.6', recognise: async () => null },
      }),
    });
    seedRecallSheet(d, '2026-08-22', ['城'], GAPPED);
    d.reviews.append([{ date: '2026-08-22', char: '城', result: 'pass', evidence: 'transcription', read: '城' }]);
    writeBackupNote(d, '2026-08-22', [0], GAPPED);

    const code = await run(['regrade', '--from=2026-08-22', '--to=2026-08-22', '--dry-run'], d);

    expect(code).toBe(1);
    expect(text()).toMatch(/degraded\s+2026-08-22: a recogniser it needs was unavailable/);
    expect(text()).toMatch(/0 skipped, 1 degraded, 0 errored/);
  });

  // Re-grading an older sheet must not count a character taught only later as one Franco
  // confused it with. 二 is drilled on 10-03, after the 10-01 sheet that asked for 一.
  it('counts as confusions only characters drilled on or before the graded date', async () => {
    const d = regradeDeps({
      now: () => new Date('2026-10-05T12:00:00'),
      recognisers: () => both(['二']),
    });
    seedRecallSheet(d, '2026-10-01', ['一'], GAPPED);
    writeBackupNote(d, '2026-10-01', [0], GAPPED);
    seedRecallSheet(d, '2026-10-03', [], GAPPED, ['二']);

    const code = await run(['regrade', '--from=2026-10-01', '--to=2026-10-01', '--dry-run'], d);

    expect(code).toBe(0);
    expect(text()).toMatch(/一 — → fail/);
    expect(text()).not.toMatch(/二/);
  });
});

describe('xiehanzi grade — recognisers unavailable', () => {
  // Written cells nobody could read are a recogniser outage, not a day off and not a broken
  // sync. The nightly window retries it, so it must not fail the job or record anything.
  it('exits 0, says it will retry, and records nothing', async () => {
    const d = deps();
    seedRecallSheet(d, '2026-08-22', ['城']);
    writeBackupNote(d, '2026-08-22', [0]);
    const bytes = readFileSync(join(d.backupDir, d.remoteDir, '2026-08-22 写汉字.note'));
    writeFileSync(d.sessionPath, JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));
    const cloud = {
      useToken: vi.fn(),
      ensureDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async () => ({
        id: 'f', directoryId: 'dir', fileName: '2026-08-22 写汉字.note',
        isFolder: false, md5: '', size: bytes.length, updateTime: 1,
      })),
      downloadFile: vi.fn(async () => bytes),
    };

    const code = await run(['grade', '--date=2026-08-22'], { ...d, cloud: () => cloud as never });

    expect(code).toBe(0);
    expect(text()).toMatch(/no recogniser could read them; it will be retried/);
    expect(d.reviews.all()).toHaveLength(0);
  });
});

describe('xiehanzi carry — no new sheet until the last one is written on', () => {
  const entry = (fileName: string, id = fileName): CloudEntry => ({
    id, directoryId: 'dir', fileName, isFolder: false, md5: '', size: 1, updateTime: Date.UTC(2026, 9, 4, 4, 20),
  });
  const blank = () => writeNote([{ background: blankLayer(1920, 2560) }], { seed: 'blank' });
  const inked = (rows: number[]) => {
    const px = new Uint8Array(1920 * 2560).fill(RLE.background);
    for (const row of rows) {
      const r = cellRect(RECALL_GEOMETRY, row, 0);
      const x0 = Math.round((r.xMm / 162.6) * 1920), x1 = Math.round(((r.xMm + r.widthMm) / 162.6) * 1920);
      const y0 = Math.round((r.yMm / 216.7) * 2560), y1 = Math.round(((r.yMm + r.heightMm) / 216.7) * 2560);
      for (let y = y0; y < y1; y += 1) px.fill(RLE.black, y * 1920 + x0, y * 1920 + x1);
    }
    return writeNote([{ background: blankLayer(1920, 2560), writing: encodeRle(px) }], { seed: 'inked' });
  };

  /** A cloud folder holding the named files, which renames for real. */
  function fakeCloud(files: Record<string, Buffer>) {
    const store = new Map(Object.entries(files));
    return {
      store,
      useToken: vi.fn(),
      ensureDirectory: vi.fn(async () => 'dir'),
      findEntry: vi.fn(async (_dir: string, name: string) => (store.has(name) ? entry(name) : undefined)),
      downloadFile: vi.fn(async (e: CloudEntry) => store.get(e.fileName)!),
      renameEntry: vi.fn(async (e: CloudEntry, newName: string) => {
        store.set(newName, store.get(e.fileName)!);
        store.delete(e.fileName);
      }),
    };
  }

  function setup(files: Record<string, Buffer>) {
    const d = deps({ now: () => new Date('2026-10-05T06:20:00') });
    writeFileSync(join(stateDir, 'session.json'), JSON.stringify({ token: 't', account: 'a', savedAt: 'x' }));
    const cloud = fakeCloud(files);
    return { d: { ...d, cloud: () => cloud as never }, cloud };
  }

  it('carries a blank sheet to today: manifest, local file and cloud file all move', async () => {
    const { d, cloud } = setup({ '2026-10-04 写汉字.note': blank() });
    seedRecallSheet(d, '2026-10-04', ['二', '三']);
    writeFileSync(join(stateDir, '2026-10-04 写汉字.note'), 'sheet');

    const code = await run(['carry'], d);

    expect(code).toBe(0);
    expect(text()).toMatch(/decision: carried$/);
    expect(d.sheets.getSheet('2026-10-04')).toBeNull();
    const carried = d.sheets.getSheet('2026-10-05')!;
    expect(carried.carriedFrom).toEqual(['2026-10-04']);
    expect(carried.recall!.map((r) => r.char)).toEqual(['二', '三']);
    expect(existsSync(join(stateDir, '2026-10-05 写汉字.note'))).toBe(true);
    expect(existsSync(join(stateDir, '2026-10-04 写汉字.note'))).toBe(false);
    expect([...cloud.store.keys()]).toEqual(['2026-10-05 写汉字.note']);
  });

  it('says generate, and moves nothing, when the last sheet was written on', async () => {
    const { d, cloud } = setup({ '2026-10-04 写汉字.note': inked([0]) });
    seedRecallSheet(d, '2026-10-04', ['二', '三']);

    await run(['carry'], d);

    expect(text()).toMatch(/decision: generate$/);
    expect(d.sheets.getSheet('2026-10-04')).not.toBeNull();
    expect(d.sheets.getSheet('2026-10-05')).toBeNull();
    expect(cloud.renameEntry).not.toHaveBeenCalled();
  });

  it('looks only at the most recent sheet, so an old orphaned blank never blocks', async () => {
    const { d } = setup({ '2026-10-03 写汉字.note': blank(), '2026-10-04 写汉字.note': inked([0]) });
    seedRecallSheet(d, '2026-10-03', ['二']);
    seedRecallSheet(d, '2026-10-04', ['三']);

    await run(['carry'], d);

    expect(text()).toMatch(/decision: generate$/);
  });

  it('never blocks on a sheet with no recall rows, since its ink cannot be judged', async () => {
    const { d, cloud } = setup({});
    d.sheets.saveSheet({ date: '2026-10-04', characters: [{ char: '二', reason: 'linear' }] });

    await run(['carry'], d);

    expect(text()).toMatch(/decision: generate$/);
    expect(cloud.findEntry).not.toHaveBeenCalled();
  });

  it('a re-run after a carry finishes the move and does not carry again', async () => {
    const { d, cloud } = setup({ '2026-10-04 写汉字.note': blank() });
    seedRecallSheet(d, '2026-10-04', ['二']);
    // Cut off after the manifest moved but before the cloud rename.
    d.sheets.carrySheet('2026-10-04', '2026-10-05');

    await run(['carry'], d);

    expect(text()).toMatch(/decision: carried$/);
    expect([...cloud.store.keys()]).toEqual(['2026-10-05 写汉字.note']);
    expect(d.sheets.getSheet('2026-10-05')!.carriedFrom).toEqual(['2026-10-04']);
  });

  it('a dry run moves nothing', async () => {
    const { d, cloud } = setup({ '2026-10-04 写汉字.note': blank() });
    seedRecallSheet(d, '2026-10-04', ['二']);

    await run(['carry', '--dry-run'], d);

    expect(text()).toMatch(/decision: carried$/);
    expect(d.sheets.getSheet('2026-10-04')).not.toBeNull();
    expect(cloud.renameEntry).not.toHaveBeenCalled();
  });

  // The firmware's handling of a cloud rename while the device holds unsynced ink is
  // unknown; if the ink comes back under the old name, grading must still find it.
  it('grading a carried date reads ink that came back under the old name', async () => {
    const { d, cloud } = setup({ '2026-10-05 写汉字.note': blank(), '2026-10-04 写汉字.note': inked([0]) });
    seedRecallSheet(d, '2026-10-04', ['二', '三']);
    d.sheets.carrySheet('2026-10-04', '2026-10-05');

    await run(['grade', '--date=2026-10-05', '--json'], d);

    const summary = JSON.parse(text());
    expect(summary.skipped).not.toBe('not-attempted');
    expect(cloud.downloadFile.mock.calls.map(([e]) => e.fileName)).toEqual([
      '2026-10-05 写汉字.note',
      '2026-10-04 写汉字.note',
    ]);
  });
});
