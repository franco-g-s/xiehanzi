/**
 * What was on each day's sheet.
 *
 * This is the only progress record. Linear catch-up's position is *derived* from these
 * manifests rather than stored alongside them: two copies of the same fact drift, and a
 * drifted position silently reprints characters or skips them — the sort of bug you would
 * not notice for weeks.
 *
 * Committed to git, so the history of what was actually practised is visible.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SelectionReason } from '../select/enrich.js';

export type SheetCharacter = {
  char: string;
  reason: SelectionReason;
  sourceWord?: string;
};

/**
 * One asked-for character, and where on the delivered sheet it was asked.
 *
 * `page` is a 0-indexed PAGE OF THE DOCUMENT, not a count of recall pages — grading indexes
 * the parsed `.note`'s pages with it directly. Since each recall page is followed by the
 * answers page that answers it, today's recall pages are document pages 0 and 2. Manifests
 * written before that interleave hold 0 and 1, which were the document pages their sheets
 * were genuinely printed on, so they still grade against the paper that exists.
 *
 * `row` is the row's index within its own recall page, which the stored geometry turns
 * into millimetres.
 */
export type RecallRow = { char: string; cue: string; page: number; row: number };

export type RecallGeometry = {
  cellMm: number;
  originXMm: number;      // left edge of cell 1
  originYMm: number;      // top edge of row 1's CELLS, below the cue line
  rowPitchMm: number;
  cellsPerRow: number;
  rowsPerPage: number;
  /**
   * Blank space between the graded first cell and the rest of the row, which shifts cells
   * 2..n right by that much.
   *
   * Optional, and absent means zero — never today's default. Every manifest written before
   * the gap existed describes a row with none, and those sheets are already printed and
   * possibly already written on; grading them has to measure the page they actually are.
   */
  firstCellGapMm?: number;
};

export type SheetManifest = {
  date: string;
  characters: SheetCharacter[];
  generatedAt: string;
  /**
   * What was asked, and where it was printed.
   *
   * The geometry is stored rather than recomputed because config changes: regrading a
   * sheet from last month against today's `recallPages` would measure ink against a
   * layout that sheet was never printed with.
   */
  recall?: RecallRow[];
  recallGeometry?: RecallGeometry;
  /**
   * Earlier dates this same sheet was delivered under, oldest first. A sheet left unwritten
   * is renamed to the next morning's date rather than joined by a new one (see `carry`), so
   * the page on the device can still print an older date than its name, and the device may
   * hand the ink back under an old name. Grading tries those names after this one.
   */
  carriedFrom?: string[];
};

export type SheetInput = Omit<SheetManifest, 'generatedAt'>;

type SheetsFile = { version: 1; sheets: Record<string, SheetManifest> };

export type SheetStore = {
  getSheet(date: string): SheetManifest | null;
  saveSheet(sheet: SheetInput): SheetManifest;
  /**
   * Every character linear catch-up has covered.
   * @param exceptDate ignore this date's sheet — used when regenerating it, so it does
   *                   not count its own previous characters as already done.
   */
  linearDone(exceptDate?: string): string[];
  allSheets(): SheetManifest[];
  /**
   * Moves a manifest to a later date, unchanged but for its date and `carriedFrom`. Keeps
   * `generatedAt`: the sheet was not generated again, only renamed. Refuses if `to` already
   * has a sheet — two manifests for one file is the corruption this exists to avoid.
   */
  carrySheet(from: string, to: string): SheetManifest;
};

export function createSheetStore(
  path: string,
  deps: { now?: () => Date } = {},
): SheetStore {
  const now = deps.now ?? (() => new Date());

  function load(): SheetsFile {
    if (!existsSync(path)) return { version: 1, sheets: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SheetsFile;
      if (typeof parsed.sheets !== 'object' || parsed.sheets === null) {
        throw new Error('missing sheets object');
      }
      return parsed;
    } catch (cause) {
      throw new Error(
        `Could not read the sheet history at ${path}: the file is not valid sheet JSON. ` +
          'Refusing to start over, which would reprint characters you have already done.',
        { cause },
      );
    }
  }

  function save(data: SheetsFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  return {
    getSheet(date) {
      return load().sheets[date] ?? null;
    },

    saveSheet(sheet) {
      const data = load();
      const previous = data.sheets[sheet.date];
      // Defence in depth: recall is written by a different code path than the drill half
      // (cli.ts's own saveSheet call, after planSheet's), and a caller that only knows
      // about characters — like planSheet's wholesale-replace save — has nothing to say
      // about recall one way or the other. Treat an omitted recall as "unchanged", not as
      // "erase it", so a caller unaware recall exists can never silently wipe it out from
      // under a guard that reads the manifest afterwards.
      const recallFields =
        sheet.recall !== undefined && sheet.recallGeometry !== undefined
          ? { recall: sheet.recall, recallGeometry: sheet.recallGeometry }
          : previous?.recall !== undefined && previous.recallGeometry !== undefined
            ? { recall: previous.recall, recallGeometry: previous.recallGeometry }
            : {};
      // Same for carriedFrom: a reprint of a carried date (generate's reuse path) knows
      // nothing about the names the file used to have, and grading still needs them.
      const carriedFields =
        sheet.carriedFrom === undefined && previous?.carriedFrom !== undefined ? { carriedFrom: previous.carriedFrom } : {};
      const manifest: SheetManifest = { ...sheet, ...recallFields, ...carriedFields, generatedAt: now().toISOString() };
      data.sheets[sheet.date] = manifest;
      save(data);
      return manifest;
    },

    linearDone(exceptDate) {
      const done = new Set<string>();
      for (const manifest of Object.values(load().sheets)) {
        if (manifest.date === exceptDate) continue;
        for (const c of manifest.characters) {
          if (c.reason === 'linear') done.add(c.char);
        }
      }
      return [...done];
    },

    carrySheet(from, to) {
      const data = load();
      const previous = data.sheets[from];
      if (previous === undefined) throw new Error(`No sheet for ${from} to carry forward.`);
      if (data.sheets[to] !== undefined) throw new Error(`${to} already has a sheet; refusing to carry ${from} onto it.`);
      const carried: SheetManifest = {
        ...previous,
        date: to,
        carriedFrom: [...(previous.carriedFrom ?? []), from],
      };
      delete data.sheets[from];
      data.sheets[to] = carried;
      save(data);
      return carried;
    },

    allSheets() {
      return Object.values(load().sheets).sort((a, b) => a.date.localeCompare(b.date));
    },
  };
}
