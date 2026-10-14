import { describe, it, expect } from 'vitest';
import { introducedDates, dueItems, needsRelearning, RELEARN_LAPSES } from './pool.js';
import { replay, type Schedule } from './schedule.js';
import type { SheetManifest } from '../state/sheets.js';

const sheet = (date: string, chars: string[]): SheetManifest => ({
  date,
  characters: chars.map((char) => ({ char, reason: 'linear' as const })),
  generatedAt: `${date}T06:00:00.000Z`,
});

const handwriting = new Set(['市', '城', '晚']);

describe('introducedDates', () => {
  it('records the first sheet a character appeared on', () => {
    const dates = introducedDates([sheet('2026-08-20', ['市']), sheet('2026-08-21', ['市', '城'])], handwriting);
    expect(dates.get('市')).toBe('2026-08-20');
    expect(dates.get('城')).toBe('2026-08-21');
  });

  it('excludes characters outside the handwriting list, however often drilled', () => {
    // 避 is a reading-only character. Asking Franco to write it manufactures failures
    // that mean nothing, because the standard never asks him to write it.
    const dates = introducedDates([sheet('2026-08-20', ['避']), sheet('2026-08-21', ['避'])], handwriting);
    expect(dates.has('避')).toBe(false);
  });

  it('takes the earliest date even when manifests arrive out of order', () => {
    const dates = introducedDates([sheet('2026-08-21', ['市']), sheet('2026-08-20', ['市'])], handwriting);
    expect(dates.get('市')).toBe('2026-08-20');
  });
});

describe('dueItems', () => {
  const schedules = (entries: Array<Pick<Schedule, 'char' | 'due'> & Partial<Schedule>>) =>
    new Map(entries.map((e) => {
      const schedule: Schedule = {
        intervalDays: 1,
        ease: 2.5,
        step: 0,
        reps: 0,
        lapses: 0,
        ...e,
      };
      return [schedule.char, schedule] as const;
    }));

  it('returns only items due on or before today', () => {
    const due = dueItems(schedules([
      { char: '市', due: '2026-08-21' }, { char: '城', due: '2026-08-25' },
    ]), '2026-08-22', 10);
    expect(due.map((s) => s.char)).toEqual(['市']);
  });

  it('puts the most overdue first, so a backlog drains oldest-first', () => {
    const due = dueItems(schedules([
      { char: '市', due: '2026-08-21' }, { char: '城', due: '2026-08-10' }, { char: '晚', due: '2026-08-15' },
    ]), '2026-08-22', 10);
    expect(due.map((s) => s.char)).toEqual(['城', '晚', '市']);
  });

  it('stops at capacity, leaving the rest to carry forward', () => {
    const due = dueItems(schedules([
      { char: '市', due: '2026-08-21' }, { char: '城', due: '2026-08-10' }, { char: '晚', due: '2026-08-15' },
    ]), '2026-08-22', 2);
    expect(due.map((s) => s.char)).toEqual(['城', '晚']);
  });

  it('is deterministic when two items are equally overdue', () => {
    const args = [schedules([{ char: '市', due: '2026-08-21' }, { char: '城', due: '2026-08-21' }]), '2026-08-22', 10] as const;
    expect(dueItems(...args)).toEqual(dueItems(...args));
  });

  it('breaks a tie by code point, not by locale collation', () => {
    // localeCompare's collation follows the runtime's ICU data and default locale, which
    // differ between the machine this is developed on and the one that actually generates
    // the sheet — the same capacity-bound tie could then pick a different subset of due
    // items depending on which machine ran it. 城 (U+57CE) sorts before 市 (U+5E02) by
    // code point; a locale-aware collation is not guaranteed to agree.
    const due = dueItems(
      schedules([{ char: '市', due: '2026-08-21' }, { char: '城', due: '2026-08-21' }]),
      '2026-08-22',
      10,
    );
    expect(due.map((s) => s.char)).toEqual(['城', '市']);
  });

  it('returns nothing when capacity is zero', () => {
    expect(dueItems(schedules([{ char: '市', due: '2026-08-01' }]), '2026-08-22', 0)).toEqual([]);
  });
});

describe('needsRelearning', () => {
  it('names characters that have lapsed enough to be re-drilled', () => {
    const reviews = [
      { date: '2026-08-21', char: '市', result: 'fail' as const, evidence: 'ink' as const },
      { date: '2026-08-22', char: '市', result: 'fail' as const, evidence: 'ink' as const },
    ];
    const schedules = replay(new Map([['市', '2026-08-20']]), reviews);
    expect(needsRelearning(schedules)).toEqual(['市']);
  });

  // One lapse, not two. Waiting for a second lapse meant a forgotten character sat in the
  // recall queue for another full cycle before anything reteaching happened, and the queue
  // was already running days behind: measured retention by lag was 75% at a 3-day gap, 42%
  // at 4 days, 25% at 5. A character missed yesterday goes back on today's drill page.
  it('re-drills a character after two lapses', () => {
    const schedules = replay(new Map([['市', '2026-08-20']]), [
      { date: '2026-08-21', char: '市', result: 'fail' as const, evidence: 'ink' as const },
      { date: '2026-08-22', char: '市', result: 'fail' as const, evidence: 'ink' as const },
    ]);
    expect(needsRelearning(schedules)).toEqual(['市']);
    expect(RELEARN_LAPSES).toBe(2);
  });

  // One miss stays with recall: a lapse already shortens the interval, so it comes back on
  // the recall page within a day or two without costing a drill row.
  it('leaves a character missed once to the recall schedule', () => {
    const schedules = replay(new Map([['市', '2026-08-20']]), [
      { date: '2026-08-21', char: '市', result: 'fail' as const, evidence: 'ink' as const },
    ]);
    expect(needsRelearning(schedules)).toEqual([]);
  });

  it('leaves a character that has never been missed alone', () => {
    const schedules = replay(new Map([['市', '2026-08-20']]), [
      { date: '2026-08-21', char: '市', result: 'pass' as const, evidence: 'ink' as const },
    ]);
    expect(needsRelearning(schedules)).toEqual([]);
  });
});
