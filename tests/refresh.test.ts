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
