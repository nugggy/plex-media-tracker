import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Its own throwaway database: startup.ts opens one on import, and test files
// run in parallel, so sharing the default file would mean sharing its locks.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-start-'));
const { syncDueOnStart, SYNC_ON_START_GAP_MS, SERVER_REFRESH_GAP_MS, nightlyScanDue } = await import('../src/startup.ts');

const NOW = Date.parse('2026-09-29T08:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('the first start ever syncs', () => {
  assert.equal(syncDueOnStart('', NOW), true);
});

test('a refresh that finished half an hour ago is recent enough to skip', () => {
  assert.equal(syncDueOnStart(ago(30 * 60_000), NOW), false);
});

test('a refresh older than the gap is due again', () => {
  assert.equal(syncDueOnStart(ago(SYNC_ON_START_GAP_MS + 1), NOW), true);
});

test('a value that is not a date does not block the sync', () => {
  assert.equal(syncDueOnStart('yesterday-ish', NOW), true);
});

test('a clock that went backwards does not block the sync for ever', () => {
  assert.equal(syncDueOnStart(ago(-48 * 3_600_000), NOW), true);
});

test('the NAS scans once a night, in the 3 am hour Sydney time', () => {
  // 03:20 AEDT on 18 October 2026 is 16:20 UTC on the 17th.
  const night = Date.parse('2026-10-17T16:20:00Z');
  assert.equal(nightlyScanDue('', night), true);
  assert.equal(nightlyScanDue('2026-10-16T16:05:00Z', night), true);
  // Already started earlier in the same hour.
  assert.equal(nightlyScanDue('2026-10-17T16:05:00Z', night), false);
  // Midday is never the time.
  assert.equal(nightlyScanDue('', Date.parse('2026-10-18T02:00:00Z')), false);
});

test('the NAS refreshes hourly, so a refresh 70 minutes ago is due there but not on a PC', () => {
  const now = Date.parse('2026-10-17T03:00:00Z');
  const last = new Date(now - 70 * 60_000).toISOString();
  assert.equal(syncDueOnStart(last, now, SERVER_REFRESH_GAP_MS), true);
  assert.equal(syncDueOnStart(last, now), false);
  assert.equal(syncDueOnStart(new Date(now - 40 * 60_000).toISOString(), now, SERVER_REFRESH_GAP_MS), false);
});
