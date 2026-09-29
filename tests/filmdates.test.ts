import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-films-'));
const { db } = await import('../src/db.ts');
const wl = await import('../src/watchlist-db.ts');
const { filmsDueForDates, DATED_RECHECK_DAYS, UNDATED_RECHECK_DAYS } = await import(
  '../src/tmdb.ts'
);

const NOW = Date.parse('2026-09-29T08:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function film(key: string, checkedAt: string | null, digital: string | null): void {
  wl.insertWatchlistItem({
    rating_key: key,
    guid: `plex://movie/${key}`,
    type: 'movie',
    title: key,
    year: 2026,
    thumb: null,
    release_date: null,
    last_episode_at: null,
    last_season_at: null,
    season_count: null,
    episode_count: null,
    continuing: false,
    public_url: null,
    added_at: null,
  });
  if (checkedAt) {
    db.prepare(
      'INSERT INTO film_dates (rating_key, tmdb_id, digital_date, checked_at) VALUES (?, ?, ?, ?)',
    ).run(key, '1', digital, checkedAt);
  }
}

film('never', null, null);
film('undated-fresh', daysAgo(0.5), null);
film('undated-stale', daysAgo(UNDATED_RECHECK_DAYS + 0.5), null);
film('dated-fresh', daysAgo(DATED_RECHECK_DAYS - 0.5), '2026-10-01');
film('dated-stale', daysAgo(DATED_RECHECK_DAYS + 0.5), '2026-10-01');

test('a film without a digital date is not asked about again on every refresh', () => {
  const due = filmsDueForDates(NOW).map((f) => f.rating_key);
  assert.ok(!due.includes('undated-fresh'));
});

test('films are re-asked once their check has gone stale', () => {
  const due = filmsDueForDates(NOW)
    .map((f) => f.rating_key)
    .sort();
  assert.deepEqual(due, ['dated-stale', 'never', 'undated-stale']);
});
