import { describe, it, expect } from 'vitest';
import { replay, latestRevisions, addDays, LEARNING_STEPS, EASE_START, MAX_INTERVAL_DAYS, type Review } from './schedule.js';

const introduced = (entries: Record<string, string>) => new Map(Object.entries(entries));
const review = (date: string, char: string, result: 'pass' | 'fail'): Review =>
  ({ date, char, result, evidence: 'transcription' });

describe('addDays', () => {
  it('advances a date', () => expect(addDays('2026-08-21', 3)).toBe('2026-08-24'));
  it('crosses a month boundary', () => expect(addDays('2026-08-30', 3)).toBe('2026-09-02'));
  it('crosses a year boundary', () => expect(addDays('2026-12-30', 3)).toBe('2027-01-02'));
});

describe('replay', () => {
  it('makes a newly drilled character due the next day', () => {
    const s = replay(introduced({ 市: '2026-08-20' }), []).get('市')!;
    expect(s.due).toBe('2026-08-21');
    expect(s.step).toBe(0);
    expect(s.reps).toBe(0);
    expect(s.ease).toBe(EASE_START);
  });

  it('advances through the learning steps without touching ease', () => {
    // An item must not inflate its ease by clearing the two easiest reviews it will get.
    const s = replay(introduced({ 市: '2026-08-20' }), [review('2026-08-21', '市', 'pass')]).get('市')!;
    expect(s.step).toBe(1);
    expect(s.intervalDays).toBe(LEARNING_STEPS[1]);
    expect(s.due).toBe(addDays('2026-08-21', LEARNING_STEPS[1]!));
    expect(s.ease).toBe(EASE_START);
  });

  it('graduates after the last step, at the last interval times ease', () => {
    const s = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'),
      review('2026-08-24', '市', 'pass'),
    ]).get('市')!;
    expect(s.step).toBeNull();
    expect(s.intervalDays).toBe(Math.round(LEARNING_STEPS[LEARNING_STEPS.length - 1]! * EASE_START));
  });

  it('raises ease only once graduated', () => {
    const s = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'),
      review('2026-08-24', '市', 'pass'),
      review('2026-09-01', '市', 'pass'),
    ]).get('市')!;
    expect(s.ease).toBeGreaterThan(EASE_START);
  });

  it('sends a failure back to the first step and counts a lapse', () => {
    const s = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'),
      review('2026-08-24', '市', 'fail'),
    ]).get('市')!;
    expect(s.step).toBe(0);
    expect(s.intervalDays).toBe(LEARNING_STEPS[0]);
    expect(s.lapses).toBe(1);
  });

  it('does not restore the old interval when a lapsed item passes again', () => {
    const lapsed = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'),
      review('2026-08-24', '市', 'pass'),
      review('2026-09-01', '市', 'fail'),
      review('2026-09-02', '市', 'pass'),
    ]).get('市')!;
    expect(lapsed.intervalDays).toBe(LEARNING_STEPS[1]);
  });

  it('keeps ease inside its bounds however many reviews arrive', () => {
    const many: Review[] = [];
    let date = '2026-08-21';
    for (let i = 0; i < 40; i += 1) { many.push(review(date, '市', 'fail')); date = addDays(date, 1); }
    const low = replay(introduced({ 市: '2026-08-20' }), many).get('市')!;
    expect(low.ease).toBeGreaterThanOrEqual(1.3);

    const wins: Review[] = [];
    date = '2026-08-21';
    for (let i = 0; i < 40; i += 1) { wins.push(review(date, '市', 'pass')); date = addDays(date, 1); }
    const high = replay(introduced({ 市: '2026-08-20' }), wins).get('市')!;
    expect(high.ease).toBeLessThanOrEqual(2.8);
  });

  it('always lengthens a graduated interval, even at minimum ease', () => {
    // interval 1 x ease 1.3 rounds back to 1, which would strand the item forever.
    const reviews: Review[] = [];
    let date = '2026-08-21';
    for (let i = 0; i < 12; i += 1) {
      reviews.push(review(date, '市', i < 8 ? 'fail' : 'pass'));
      date = addDays(date, 1);
    }
    const s = replay(introduced({ 市: '2026-08-20' }), reviews).get('市')!;
    expect(s.intervalDays).toBeGreaterThan(1);
  });

  it('is deterministic — replaying twice gives identical schedules', () => {
    const args = [introduced({ 市: '2026-08-20', 城: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'), review('2026-08-21', '城', 'fail'),
    ]] as const;
    expect(replay(...args)).toEqual(replay(...args));
  });

  it('ignores reviews for characters that were never drilled', () => {
    const schedules = replay(introduced({ 市: '2026-08-20' }), [review('2026-08-21', '龍', 'pass')]);
    expect(schedules.has('龍')).toBe(false);
  });

  it('replays reviews in date order regardless of how they are stored', () => {
    const ordered = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-21', '市', 'pass'), review('2026-08-24', '市', 'pass'),
    ]).get('市')!;
    const shuffled = replay(introduced({ 市: '2026-08-20' }), [
      review('2026-08-24', '市', 'pass'), review('2026-08-21', '市', 'pass'),
    ]).get('市')!;
    expect(shuffled).toEqual(ordered);
  });

  it('breaks same-date ties by record content, not input order', () => {
    // A transcription verdict and an ink verdict can both land on one character on one
    // day, so the date alone does not order them — the array position must not matter.
    const reviewPass = review('2026-08-21', '市', 'pass');
    const reviewFail = review('2026-08-21', '市', 'fail');
    const passFirst = replay(introduced({ 市: '2026-08-20' }), [reviewPass, reviewFail]).get('市')!;
    const failFirst = replay(introduced({ 市: '2026-08-20' }), [reviewFail, reviewPass]).get('市')!;
    expect(failFirst).toEqual(passFirst);
  });

  it('plateaus intervalDays at the cap instead of compounding without bound', () => {
    // The ease-bounds test above already drives 40 consecutive graduated passes; this test
    // asserts the growth cap directly, rather than only checking the ease ceiling it happens
    // to also respect.
    const wins: Review[] = [];
    let date = '2026-08-21';
    for (let i = 0; i < 40; i += 1) { wins.push(review(date, '市', 'pass')); date = addDays(date, 1); }
    const s = replay(introduced({ 市: '2026-08-20' }), wins).get('市')!;
    expect(s.intervalDays).toBe(MAX_INTERVAL_DAYS);
  });
});

describe('revisions', () => {
  const introduced = new Map([['真', '2026-09-01']]);

  it('replays only the highest revision of each date', () => {
    const reviews: Review[] = [
      { date: '2026-09-02', char: '真', result: 'fail', evidence: 'transcription', read: '直' },
      { date: '2026-09-02', char: '真', result: 'pass', evidence: 'recognition', revision: 1 },
    ];
    expect(replay(introduced, reviews).get('真')!.lapses).toBe(0);
  });

  it('treats a review without a revision as revision 0', () => {
    const reviews: Review[] = [
      { date: '2026-09-02', char: '真', result: 'pass', evidence: 'ink' },
    ];
    expect(latestRevisions(reviews)).toEqual(reviews);
  });

  it('keeps dates independent: a revision on one date leaves another date alone', () => {
    const reviews: Review[] = [
      { date: '2026-09-02', char: '真', result: 'fail', evidence: 'ink' },
      { date: '2026-09-05', char: '真', result: 'fail', evidence: 'ink' },
      { date: '2026-09-05', char: '真', result: 'pass', evidence: 'recognition', revision: 1 },
    ];
    expect(latestRevisions(reviews).map((r) => [r.date, r.result])).toEqual([
      ['2026-09-02', 'fail'],
      ['2026-09-05', 'pass'],
    ]);
  });
});
