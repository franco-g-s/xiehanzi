/**
 * The manual pin queue.
 *
 * Characters put here by `xiehanzi add` or `xiehanzi learn` are placed on the next sheet
 * ahead of whatever the active selection mode chose. Entries are archived on use, never
 * deleted, so a failed render can't silently swallow a pin.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DecomposedChar } from '../select/decompose.js';

export type QueueEntry = {
  char: string;
  sourceWord?: string;
  /** `null` means "next available sheet". */
  date: string | null;
  note?: string;
  addedAt: string;
  /** Set once the character has appeared on a sheet. */
  consumedOn?: string;
};

type QueueFile = { version: 1; entries: QueueEntry[] };

export type AddOptions = {
  date?: string | null;
  note?: string;
};

export type QueueStore = {
  add(chars: readonly (string | DecomposedChar)[], options?: AddOptions): QueueEntry[];
  /** Pins due on or before `date` that haven't been used, date-pinned ones first. */
  pending(date: string): QueueEntry[];
  consume(chars: readonly string[], onDate: string): void;
  all(): QueueEntry[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function format(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Turns `--on=` into a date. Deliberately accepts very little: a wrong guess here puts
 * characters on the wrong day, which is invisible until you notice the sheet is odd.
 */
export function resolveDate(input: string | undefined, now: Date): string | null {
  if (input === undefined) return null;

  const value = input.trim().toLowerCase();
  if (value === 'today') return format(now);
  if (value === 'tomorrow') {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    return format(next);
  }

  if (!ISO_DATE.test(value)) {
    throw new Error(`Cannot understand date "${input}". Use today, tomorrow, or YYYY-MM-DD.`);
  }
  // Round-tripping catches impossible dates like 2026-13-45, which Date happily rolls over.
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime()) || format(parsed) !== value) {
    throw new Error(`"${input}" is not a real date.`);
  }
  return value;
}

export function createQueueStore(
  path: string,
  deps: { now?: () => Date } = {},
): QueueStore {
  const now = deps.now ?? (() => new Date());

  function load(): QueueFile {
    if (!existsSync(path)) return { version: 1, entries: [] };
    const raw = readFileSync(path, 'utf8');
    try {
      const parsed = JSON.parse(raw) as QueueFile;
      if (!Array.isArray(parsed.entries)) throw new Error('missing entries array');
      return parsed;
    } catch (cause) {
      // Starting fresh here would silently discard every pending pin.
      throw new Error(`Could not read the queue at ${path}: the file is not valid queue JSON.`, {
        cause,
      });
    }
  }

  function save(data: QueueFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    // Write-then-rename so an interrupted run can't leave a half-written queue.
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  return {
    all: () => load().entries,

    add(chars, options = {}) {
      const data = load();
      const date = options.date ?? null;
      const added: QueueEntry[] = [];

      for (const item of chars) {
        const char = typeof item === 'string' ? item : item.char;
        const sourceWord = typeof item === 'string' ? undefined : item.sourceWord;

        const alreadyPending = data.entries.some(
          (e) => e.char === char && e.date === date && e.consumedOn === undefined,
        );
        if (alreadyPending) continue;

        const entry: QueueEntry = {
          char,
          ...(sourceWord === undefined ? {} : { sourceWord }),
          date,
          ...(options.note === undefined ? {} : { note: options.note }),
          addedAt: now().toISOString(),
        };
        data.entries.push(entry);
        added.push(entry);
      }

      if (added.length > 0) save(data);
      return added;
    },

    pending(date) {
      const live = load().entries.filter((e) => e.consumedOn === undefined);
      // An overdue pin still matters — it was never actually practised.
      const dated = live.filter((e) => e.date !== null && e.date <= date);
      const undated = live.filter((e) => e.date === null);
      return [...dated, ...undated];
    },

    consume(chars, onDate) {
      const data = load();
      const wanted = new Set(chars);
      let changed = false;

      for (const entry of data.entries) {
        if (entry.consumedOn === undefined && wanted.has(entry.char)) {
          entry.consumedOn = onDate;
          changed = true;
        }
      }

      if (changed) save(data);
    },
  };
}
