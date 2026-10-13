import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database in manual mode, with every network call answered by
// the stub below, so nothing leaves this machine.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-refresh-'));
const store = await import('../src/db.ts');
const { refreshLibraryState } = await import('../src/watchlist.ts');

const SERVER = 'http://plex.test:32400';
store.setSetting('plex_connection', 'manual');
store.setSetting('plex_url', SERVER);
store.setSetting('plex_token', 'tok');
store.setSetting('plex_section', '');
store.setSetting('watchlist_enabled', '1');
store.setSetting('tmdb_api_key', '');

const calls: string[] = [];
let serverStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  calls.push(url.origin + url.pathname);
  const status = url.origin === SERVER ? serverStatus : 200;
  return new Response(
    JSON.stringify({ MediaContainer: { Directory: [], Metadata: [], totalSize: 0 } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}) as typeof fetch;

test('a watchlist refresh does not read the home server', async () => {
  calls.length = 0;
  await refreshLibraryState(undefined, ['watchlist']);
  assert.deepEqual(
    calls.filter((c) => c.startsWith(SERVER)),
    [],
  );
});

test('a full refresh reads the film and TV sections once, not twice', async () => {
  calls.length = 0;
  await refreshLibraryState();
  assert.equal(calls.filter((c) => c === `${SERVER}/library/sections`).length, 1);
});

test('a clean full refresh is remembered, so the next start can skip it', async () => {
  store.setSetting('last_refresh_at', '');
  await refreshLibraryState();
  assert.ok(store.getSetting('last_refresh_at') > '2026');
});

test('a refresh that could not reach the server is not remembered as done', async () => {
  store.setSetting('last_refresh_at', '');
  serverStatus = 500;
  try {
    await refreshLibraryState();
  } finally {
    serverStatus = 200;
  }
  assert.equal(store.getSetting('last_refresh_at'), '');
});

test('a partial refresh is not remembered as a full one', async () => {
  store.setSetting('last_refresh_at', '');
  await refreshLibraryState(undefined, ['watchlist']);
  assert.equal(store.getSetting('last_refresh_at'), '');
});

test('a refresh that cannot reach the server still reports what it holds', async () => {
  store.db.exec(`INSERT INTO releases (mb_id, plex_key, title, norm_title, owned, first_seen_at)
                 VALUES ('held-1', 'a1', 'Held', 'held', 1, '2026-01-01')`);
  store.db.exec(`INSERT INTO plex_albums (plex_key, artist_key, title, norm_title)
                 VALUES ('p1', 'a1', 'Held', 'held')`);
  store.db.exec(`INSERT INTO local_episodes (show_guid, season, episode)
                 VALUES ('plex://show/x', 1, 1), ('plex://show/x', 1, 2)`);
  store.setSetting('plex_section', '1');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(SERVER)) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return real(input, init);
  }) as typeof fetch;
  try {
    const result = await refreshLibraryState();
    assert.match(result.message, /1 releases already held/);
    assert.match(result.message, /2 episodes on the server/);
    assert.doesNotMatch(result.message, /\.\./);
    assert.equal(
      result.problem,
      'Your Plex server did not answer. Check that it is switched on and connected.',
    );
  } finally {
    globalThis.fetch = real;
    store.setSetting('plex_section', '');
    store.db.exec(`DELETE FROM releases; DELETE FROM plex_albums; DELETE FROM local_episodes`);
  }
});

test('with the watchlist off, a clean run of the remaining parts still counts as full', async () => {
  store.setSetting('last_refresh_at', '');
  store.setSetting('watchlist_enabled', '0');
  try {
    await refreshLibraryState();
    assert.ok(store.getSetting('last_refresh_at') > '2026');
  } finally {
    store.setSetting('watchlist_enabled', '1');
  }
});

test('with the watchlist off, a holdings-only run counts as full too', async () => {
  store.setSetting('last_refresh_at', '');
  store.setSetting('watchlist_enabled', '0');
  try {
    await refreshLibraryState(undefined, ['holdings']);
    assert.ok(store.getSetting('last_refresh_at') > '2026');
  } finally {
    store.setSetting('watchlist_enabled', '1');
  }
});

test('a refresh told to stop does nothing more, says so, and is not remembered as done', async () => {
  store.setSetting('last_refresh_at', '');
  calls.length = 0;
  const result = await refreshLibraryState(undefined, undefined, false, () => true);
  assert.equal(result.stopped, true);
  assert.deepEqual(calls, []);
  assert.equal(store.getSetting('last_refresh_at'), '');
});

test('Stop pressed during a refresh ends it as stopped, not done', async () => {
  const { runRefresh, requestStop, getProgress } = await import('../src/scanner.ts');
  store.setSetting('plex_section', '1');
  try {
    const running = runRefresh();
    assert.equal(getProgress().running, true);
    requestStop();
    const end = await running;
    assert.equal(end.phase, 'stopped');
    assert.equal(end.running, false);
    assert.match(end.reason ?? '', /stopped before it finished/);
    // The next run starts clean rather than stopping straight away.
    const again = await runRefresh();
    assert.equal(again.phase, 'done');
  } finally {
    store.setSetting('plex_section', '');
  }
});
