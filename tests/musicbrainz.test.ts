import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDate, datePrecision, searchArtist, browseReleaseGroups } from '../src/musicbrainz.ts';

/* ------------------------------------------------------------- dates */

test('a full date is kept as it is', () => {
  assert.equal(normaliseDate('2026-11-14'), '2026-11-14');
  assert.equal(datePrecision('2026-11-14'), 'day');
});

test('a month alone is padded to the last day of that month', () => {
  assert.equal(normaliseDate('2026-11'), '2026-11-30');
  assert.equal(normaliseDate('2026-12'), '2026-12-31');
  assert.equal(normaliseDate('2027-02'), '2027-02-28');
  assert.equal(normaliseDate('2028-02'), '2028-02-29'); // a leap year
  assert.equal(datePrecision('2026-11'), 'month');
});

test('a year alone is padded to 31 December', () => {
  assert.equal(normaliseDate('2027'), '2027-12-31');
  assert.equal(datePrecision('2027'), 'year');
});

test('a partial date is not out until its period is over', () => {
  // Out now is release_date <= today, so mid November is still Coming soon.
  assert.ok(normaliseDate('2026-11')! > '2026-11-15');
  assert.ok(normaliseDate('2026-11')! <= '2026-11-30');
  assert.ok(normaliseDate('2026')! > '2026-10-13');
});

test('nonsense and missing dates give nothing', () => {
  assert.equal(normaliseDate(undefined), null);
  assert.equal(normaliseDate(''), null);
  assert.equal(normaliseDate('2026-13'), null);
  assert.equal(normaliseDate('soon'), null);
  assert.equal(datePrecision('soon'), null);
});

/* ------------------------------------------------- spacing and retries */

// The client waits over a second between requests and seconds more after a
// refusal. The clock is mocked so these run in milliseconds.
mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });

const calls: number[] = [];
let answers: number[] = [];
globalThis.fetch = (async () => {
  calls.push(Date.now());
  const status = answers.shift() ?? 200;
  return new Response(JSON.stringify({ artists: [{ id: 'a', name: 'A', score: 100 }], 'release-groups': [] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

/** Moves the mocked clock on in small steps until the promise settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 2_000 && !done; i += 1) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(50);
  }
  return p;
}

function reset(statuses: number[] = []): void {
  calls.length = 0;
  answers = statuses;
}

test('requests are spaced at least 1.1 seconds apart, even when asked for together', async () => {
  reset();
  await settle(Promise.all([searchArtist('One'), searchArtist('Two'), searchArtist('Three')]));
  assert.equal(calls.length, 3);
  for (let i = 1; i < calls.length; i += 1) assert.ok(calls[i]! - calls[i - 1]! >= 1100, `gap ${i}`);
});

test('a 503 is waited out and tried again', async () => {
  reset([503]);
  const found = await settle(searchArtist('Busy'));
  assert.equal(found[0]?.id, 'a');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]! - calls[0]! >= 2000);
});

test('a 429 is treated the same way', async () => {
  reset([429, 429]);
  const found = await settle(browseReleaseGroups('mbid'));
  assert.deepEqual(found, []);
  assert.equal(calls.length, 3);
});

test('three refusals in a row give up with the rate-limit error', async () => {
  reset([503, 503, 503]);
  await assert.rejects(settle(searchArtist('Never')), /rate-limited/);
  assert.equal(calls.length, 3);
});

test('a 404 is an answer, not something to retry', async () => {
  reset([404]);
  await assert.rejects(settle(searchArtist('Nobody')), /Not found in MusicBrainz/);
  assert.equal(calls.length, 1);
});
