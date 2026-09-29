import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncDueOnStart, SYNC_ON_START_GAP_MS } from '../src/startup.ts';

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
