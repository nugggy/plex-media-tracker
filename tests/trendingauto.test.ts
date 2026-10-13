import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Its own throwaway database, since importing trending opens one.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-trendingauto-'));
const { trendingStale, shouldAutoBuild, buildableKinds, maybeAutoBuildTrending } = await import(
  '../src/trendingauto.ts'
);

const NOW = Date.parse('2026-10-13T00:00:00Z');
const daysBefore = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const all = (iso: string | null) => ({ movie: iso, show: iso, album: iso });

/* ------------------------------------------------------------ staleness */

test('charts built this week are not stale', () => {
  assert.equal(trendingStale(all(daysBefore(3)), true, NOW), false);
});

test('a chart more than a week old makes the charts stale', () => {
  assert.equal(trendingStale({ ...all(daysBefore(1)), show: daysBefore(8) }, true, NOW), true);
});

test('exactly a week old is not yet stale', () => {
  assert.equal(trendingStale(all(daysBefore(7)), true, NOW), false);
});

test('charts never built are stale', () => {
  assert.equal(trendingStale(all(null), true, NOW), true);
});

test('without a TMDB key only the albums chart counts, since films and shows can never build', () => {
  assert.deepEqual(buildableKinds(false), ['album']);
  assert.equal(trendingStale({ movie: null, show: null, album: daysBefore(2) }, false, NOW), false);
  assert.equal(trendingStale({ movie: null, show: null, album: daysBefore(9) }, false, NOW), true);
});

test('a build stamped in the future is not trusted', () => {
  assert.equal(trendingStale(all(new Date(NOW + 86_400_000).toISOString()), true, NOW), true);
});

/* ------------------------------------------------------------- deciding */

const ready = { stale: true, configured: true, building: false, scanning: false, lastFailureAt: '', now: NOW };

test('stale charts with nothing in the way start a build', () => {
  assert.equal(shouldAutoBuild(ready), true);
});

test('current charts start nothing', () => {
  assert.equal(shouldAutoBuild({ ...ready, stale: false }), false);
});

test('nothing starts until Plex is set up', () => {
  assert.equal(shouldAutoBuild({ ...ready, configured: false }), false);
});

test('a build already running is never joined by a second', () => {
  assert.equal(shouldAutoBuild({ ...ready, building: true }), false);
});

test('a music scan holds the build back rather than share MusicBrainz with it', () => {
  assert.equal(shouldAutoBuild({ ...ready, scanning: true }), false);
});

test('a failure in the last six hours stops a retry', () => {
  assert.equal(shouldAutoBuild({ ...ready, lastFailureAt: daysBefore(0.2) }), false);
});

test('a failure more than six hours ago allows another go', () => {
  assert.equal(shouldAutoBuild({ ...ready, lastFailureAt: daysBefore(0.3) }), true);
});

test('a failure stamped in the future does not hold builds back for ever', () => {
  assert.equal(shouldAutoBuild({ ...ready, lastFailureAt: new Date(NOW + 3_600_000).toISOString() }), true);
});

test('with Plex not set up, nothing is started for real', () => {
  assert.equal(maybeAutoBuildTrending(), false);
});
