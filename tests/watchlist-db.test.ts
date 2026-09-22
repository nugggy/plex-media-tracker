import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countableForBadge } from '../src/watchlist-db.ts';

const row = (over: Record<string, unknown> = {}) => ({
  in_library: 0,
  date_kind: 'digital',
  ...over,
});

test('something already on the server is not something left to get', () => {
  assert.equal(countableForBadge(row({ in_library: 1 })), false);
});

test('a cinema-only film is not counted, because it cannot be watched at home yet', () => {
  assert.equal(countableForBadge(row({ date_kind: 'cinema' })), false);
});

test('a film with a digital date is counted', () => {
  assert.equal(countableForBadge(row()), true);
});

test('a film with no date kind known is counted rather than dropped', () => {
  assert.equal(countableForBadge(row({ date_kind: null })), true);
});
