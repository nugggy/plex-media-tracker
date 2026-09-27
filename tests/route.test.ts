import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Points the app at a throwaway folder before anything opens the database.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-route-'));
const { route } = await import('../src/route.ts');

const json = (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body));
const u = (p: string) => new URL(`http://app${p}`);

test('a GET reaches the same handler the PC server uses', async () => {
  const r = await route('GET', u('/api/settings'));
  assert.equal(r.status, 200);
  assert.match(r.headers['Content-Type'] ?? '', /application\/json/);
  assert.equal(json(r).settings.plex_token, '');
});

test('a POST body is read and saved', async () => {
  const saved = await route('POST', u('/api/settings'), JSON.stringify({ recent_days: '30' }));
  assert.equal(saved.status, 200);
  assert.equal(json(await route('GET', u('/api/settings'))).settings.recent_days, '30');
});

test('an unknown endpoint is a JSON 404', async () => {
  const r = await route('GET', u('/api/nope'));
  assert.equal(r.status, 404);
  assert.equal(json(r).error, 'No such endpoint');
});

test('a path outside the API is a plain 404, not a crash', async () => {
  assert.equal((await route('GET', u('/index.html'))).status, 404);
});

test('settings say which platform and version this is, and where releases live', async () => {
  const body = json(await route('GET', u('/api/settings')));
  assert.equal(body.platform, 'desktop');
  assert.equal(body.version, '1.2.0');
  assert.match(body.releases_url, /^https:\/\/github\.com\/[^/]+\/plex-media-tracker\/releases\/latest$/);
});

test('a fresh PC database keeps the typed-address connection', async () => {
  assert.equal(json(await route('GET', u('/api/settings'))).settings.plex_connection, 'manual');
});
