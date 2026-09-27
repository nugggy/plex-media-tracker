import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAir, nextDay, epKey, airstampIndex, tvmazeLookupUrl } from '../src/airtimes.ts';

/*
 * The two shows that exposed the bug. Plex calls both of them the 22nd, being
 * the date in the show's own country. Sydney does not get either until the
 * 23rd, which is what the air stamp says once it is read as an instant.
 */
test('a US primetime broadcast lands on the next Sydney day', () => {
  // R.J. Decker S2E2, ABC, 22:00 America/New_York on the 22nd.
  const air = resolveAir('2026-09-22', '2026-09-23T02:00:00+00:00', 'matched');
  assert.equal(air.air_date, '2026-09-23');
  assert.equal(air.air_source, 'tvmaze');
  assert.equal(air.air_stamp, '2026-09-23T02:00:00+00:00');
});

test('a streaming drop is read as an instant, not a date', () => {
  // Ted Lasso S4E8, Apple TV, noon UTC, which is 10pm in Sydney the same day.
  const air = resolveAir('2026-09-22', '2026-09-23T12:00:00+00:00', 'matched');
  assert.equal(air.air_date, '2026-09-23');
});

/*
 * An instant late in the Sydney evening still belongs to that Sydney day. This
 * is the case a blanket "add a day" rule would get wrong, and the reason the
 * stamp is converted rather than shifted.
 */
test('an instant Sydney gets the same day is not pushed forward', () => {
  // 00:00 America/Los_Angeles on the 22nd is 5pm in Sydney on the 22nd.
  const air = resolveAir('2026-09-22', '2026-09-22T07:00:00+00:00', 'matched');
  assert.equal(air.air_date, '2026-09-22');
});

test('an instant just before Sydney midnight stays on its own day', () => {
  const air = resolveAir('2026-09-22', '2026-09-22T13:59:00+00:00', 'matched');
  assert.equal(air.air_date, '2026-09-22'); // 11:59pm Sydney
  const after = resolveAir('2026-09-22', '2026-09-22T14:01:00+00:00', 'matched');
  assert.equal(after.air_date, '2026-09-23'); // 12:01am Sydney
});

/*
 * A show TVMaze has never heard of gets the conservative reading: an origin
 * date is not claimed as out until the Sydney day after it, so the feed never
 * announces something that has not happened.
 */
test('a show TVMaze does not carry is held back a day', () => {
  const air = resolveAir('2026-09-22', undefined, 'absent');
  assert.equal(air.air_date, '2026-09-23');
  assert.equal(air.air_source, 'estimated');
  assert.equal(air.air_stamp, null);
});

test('an episode missing from an otherwise matched show is estimated too', () => {
  const air = resolveAir('2026-09-22', undefined, 'matched');
  assert.equal(air.air_date, '2026-09-23');
  assert.equal(air.air_source, 'estimated');
});

/*
 * A lookup that could not be made is not evidence of anything. Shifting on a
 * dropped connection would walk every date forward a day per failed refresh.
 */
test('an unreachable lookup leaves the Plex date alone', () => {
  const air = resolveAir('2026-09-22', undefined, 'unknown');
  assert.equal(air.air_date, '2026-09-22');
  assert.equal(air.air_source, 'plex');
});

test('an episode with no date at all stays undated', () => {
  for (const lookup of ['matched', 'absent', 'unknown'] as const) {
    const air = resolveAir(null, undefined, lookup);
    assert.equal(air.air_date, null);
    assert.equal(air.air_stamp, null);
  }
});

test('the next day crosses months, years and leap days', () => {
  assert.equal(nextDay('2026-09-22'), '2026-09-23');
  assert.equal(nextDay('2026-09-30'), '2026-10-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
});

/* ------------------------------------------------------------- lookups */

test('episodes are keyed by season and number', () => {
  assert.equal(epKey(4, 8), '4|8');
  assert.equal(epKey(null, 8), null);
  assert.equal(epKey(4, null), null);
});

test('an air stamp index is built from a TVMaze episode list', () => {
  const index = airstampIndex([
    { season: 4, number: 7, airstamp: '2026-09-16T12:00:00+00:00' },
    { season: 4, number: 8, airstamp: '2026-09-23T12:00:00+00:00' },
    { season: 4, number: 9, airstamp: null },
    { season: null, number: 1, airstamp: '2026-09-23T12:00:00+00:00' },
  ]);
  assert.equal(index.get('4|8'), '2026-09-23T12:00:00+00:00');
  assert.equal(index.size, 2); // the undated and the unnumbered are skipped
});

/*
 * TVDB is the id TVMaze matches most reliably for television, so it is tried
 * first, with IMDb as the fallback. A show carrying neither cannot be looked up.
 */
test('a show is looked up by TVDB first, then IMDb', () => {
  assert.equal(
    tvmazeLookupUrl({ tvdb: '383203', imdb: 'tt10986410', tmdb: '97546' }),
    'https://api.tvmaze.com/lookup/shows?thetvdb=383203',
  );
  assert.equal(
    tvmazeLookupUrl({ imdb: 'tt10986410' }),
    'https://api.tvmaze.com/lookup/shows?imdb=tt10986410',
  );
  assert.equal(tvmazeLookupUrl({ tmdb: '97546' }), null);
  assert.equal(tvmazeLookupUrl({}), null);
});
