import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-walks-'));
const { showDueForWalk, WALK_GAP_MS, recordWalk, lastWalk } = await import('../src/episodes.ts');

const NOW = Date.parse('2026-09-29T08:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('a show never walked is due', () => {
  assert.equal(showDueForWalk(undefined, '2026-09-20', NOW), true);
});

test('a show walked this morning with nothing new is left alone', () => {
  const walk = { walked_at: ago(2 * 3_600_000), last_episode_at: '2026-09-20' };
  assert.equal(showDueForWalk(walk, '2026-09-20', NOW), false);
});

test('a show whose last episode date moved is walked again straight away', () => {
  const walk = { walked_at: ago(2 * 3_600_000), last_episode_at: '2026-09-20' };
  assert.equal(showDueForWalk(walk, '2026-09-28', NOW), true);
});

test('a show walked longer ago than the gap is due again', () => {
  const walk = { walked_at: ago(WALK_GAP_MS + 1), last_episode_at: '2026-09-20' };
  assert.equal(showDueForWalk(walk, '2026-09-20', NOW), true);
});

test('a show with no last episode date known is still spared a rewalk', () => {
  const walk = { walked_at: ago(60_000), last_episode_at: null };
  assert.equal(showDueForWalk(walk, null, NOW), false);
});

test('a walk is remembered with the last episode date it saw', () => {
  recordWalk('show-1', '2026-09-20', new Date(NOW).toISOString());
  assert.deepEqual(lastWalk('show-1'), {
    walked_at: new Date(NOW).toISOString(),
    last_episode_at: '2026-09-20',
  });
  recordWalk('show-1', '2026-09-27', ago(-60_000));
  assert.equal(lastWalk('show-1')?.last_episode_at, '2026-09-27');
  assert.equal(lastWalk('nobody'), undefined);
});
