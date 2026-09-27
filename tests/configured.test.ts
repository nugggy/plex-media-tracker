import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-conf-'));
const store = await import('../src/db.ts');

test('automatic mode counts as set up before any address has been found', () => {
  store.setSetting('plex_token', 't');
  store.setSetting('plex_section', '1');
  store.setSetting('plex_connection', 'auto');
  store.setSetting('plex_machine_id', 'abc');
  store.setSetting('plex_url', '');
  assert.equal(store.isConfigured(), true);
});

test('manual mode still needs an address', () => {
  store.setSetting('plex_connection', 'manual');
  store.setSetting('plex_url', '');
  assert.equal(store.isConfigured(), false);
});
