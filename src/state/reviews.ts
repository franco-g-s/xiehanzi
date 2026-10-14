/**
 * Every recall verdict ever reached, append-only.
 *
 * This is the whole of recall's persistent state. Intervals, ease and due dates are
 * replayed from it by `recall/schedule.ts` and never written down, so there is no second
 * copy to drift. Committed to git, like the sheet manifests, because it is the record of
 * what was actually recalled.
 *
 * There is no 'not attempted' record. A row that was never written on appends nothing at
 * all — the absence of a record is what carries the item forward, and a state that is
 * never written cannot be written wrong.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { latestRevisions, type Review } from '../recall/schedule.js';

type ReviewsFile = { version: 1; reviews: Review[] };

export type ReviewStore = {
  all(): Review[];
  append(reviews: readonly Review[]): void;
  /** Reviews already recorded for a date, so grading the same sheet twice is a no-op. */
  forDate(date: string): Review[];
  /** The verdicts that currently count for a date: its highest revision only. */
  latestForDate(date: string): Review[];
};

export function createReviewStore(path: string): ReviewStore {
  function load(): ReviewsFile {
    if (!existsSync(path)) return { version: 1, reviews: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReviewsFile;
      if (!Array.isArray(parsed.reviews)) {
        throw new Error('missing reviews array');
      }
      return parsed;
    } catch (cause) {
      throw new Error(
        `Could not read the review log at ${path}: the file is not valid review JSON. ` +
          'Refusing to start over, which would reset every interval you have earned.',
        { cause },
      );
    }
  }

  function save(data: ReviewsFile): void {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  return {
    all() {
      return load().reviews;
    },

    append(reviews) {
      const data = load();
      data.reviews.push(...reviews);
      save(data);
    },

    forDate(date) {
      return load().reviews.filter((r) => r.date === date);
    },

    latestForDate(date) {
      return latestRevisions(load().reviews.filter((r) => r.date === date));
    },
  };
}
