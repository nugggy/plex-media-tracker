import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database, pointed at an address where nothing listens, with the
// watchlist off so the refresh never leaves this machine.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-hooks-'));
const store = await import('../src/db.ts');
const { runRefresh, runScan, scanHooks, getProgress } = await import('../src/scanner.ts');

test('an unconfigured app never starts the background service', async () => {
  const calls: string[] = [];
  scanHooks.onStart = () => calls.push('start');
  scanHooks.onEnd = () => calls.push('end');
  await runScan();
  await runRefresh();
  assert.deepEqual(calls, []);
});

test('a refresh starts the service once and stops it once it has finished', async () => {
  store.setSetting('plex_url', 'http://127.0.0.1:1');
  store.setSetting('plex_token', 'test');
  store.setSetting('plex_section', '1');
  store.setSetting('watchlist_enabled', '0');
  const calls: string[] = [];
  scanHooks.onStart = () => calls.push(`start:${getProgress().running}`);
  scanHooks.onEnd = () => calls.push(`end:${getProgress().running}`);
  await runRefresh();
  assert.deepEqual(calls, ['start:true', 'end:false']);
});
