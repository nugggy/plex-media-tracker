import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Points the app at a throwaway folder before anything opens the database.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-route-'));
const { route } = await import('../src/route.ts');
const { APP_VERSION } = await import('../src/version.ts');

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
  assert.equal(body.version, APP_VERSION);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.match(body.releases_url, /^https:\/\/github\.com\/[^/]+\/plex-media-tracker\/releases\/latest$/);
});

test('a fresh PC database keeps the typed-address connection', async () => {
  assert.equal(json(await route('GET', u('/api/settings'))).settings.plex_connection, 'manual');
});

/* ---------------------------------------------------- the route table */

const post = (p: string, body: unknown) => route('POST', u(p), JSON.stringify(body));

test('every route in the table is a GET or POST under /api/', async () => {
  const { ROUTES } = await import('../src/api.ts');
  const keys = Object.keys(ROUTES);
  assert.ok(keys.length > 40);
  for (const key of keys) assert.match(key, /^(GET|POST) \/api\/[a-z/]+$/, key);
});

test('a known path asked for with the wrong method is a 404, not the handler', async () => {
  const r = await route('POST', u('/api/state'));
  assert.equal(r.status, 404);
  assert.equal((await route('GET', u('/api/scan/stop'))).status, 404);
});

test('saved secrets are masked when settings are read, and the mask never overwrites them', async () => {
  await post('/api/settings', { plex_token: 'real-token', tmdb_api_key: 'real-key' });
  const body = json(await route('GET', u('/api/settings')));
  assert.equal(body.settings.plex_token, '********');
  assert.equal(body.settings.tmdb_api_key, '********');
  assert.equal(body.token_set, true);

  await post('/api/settings', { plex_token: '********', tmdb_api_key: '********' });
  const { getSetting } = await import('../src/db.ts');
  assert.equal(getSetting('plex_token'), 'real-token');
  assert.equal(getSetting('tmdb_api_key'), 'real-key');
});

test('settings outside the allowed list, singles included, are ignored', async () => {
  await post('/api/settings', { include_single: '1', last_refresh_at: 'tampered' });
  const { getSetting } = await import('../src/db.ts');
  assert.equal(getSetting('include_single'), '');
  assert.notEqual(getSetting('last_refresh_at'), 'tampered');
  assert.equal('include_single' in json(await route('GET', u('/api/settings'))).settings, false);
});

test('a test with the masked token uses the saved one', async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(new URL(String(input instanceof Request ? input.url : input)).searchParams.get('X-Plex-Token') ?? '');
    return new Response(JSON.stringify({ MediaContainer: { Directory: [] } }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await post('/api/plex/test', { plex_url: 'http://plex.test:32400', plex_token: '********' });
    assert.equal(r.status, 200);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((t) => t === 'real-token'));
  } finally {
    globalThis.fetch = real;
  }
});

test('Plex keys that could reach another path are refused before Plex is asked', async () => {
  const refused = [
    route('GET', u('/api/lyrics/tracks?album=../../status/sessions')),
    route('GET', u('/api/lyrics/tracks?artist=12/children')),
    route('GET', u('/api/lyrics/tracks?album=1%3FX-Plex-Token%3Dx')),
    post('/api/lyrics/export', { keys: ['1', '2/../3'] }),
    post('/api/watchlist/remove', { rating_key: 'abc&ratingKey=def' }),
    post('/api/watchlist/restore', { rating_key: '../x' }),
    post('/api/search/add', { kind: 'movie', id: 'a/b' }),
    route('GET', u('/api/search/details?kind=movie&id=..%2F..')),
    post('/api/settings', { plex_section: '1/../2' }),
  ];
  for (const r of await Promise.all(refused)) {
    assert.equal(r.status, 400, JSON.stringify(json(r)));
    assert.ok(json(r).error);
  }
});

test('missing required fields are a 400 with a message', async () => {
  for (const r of await Promise.all([
    post('/api/releases/dismiss', {}),
    post('/api/artists/mute', {}),
    post('/api/artists/mbid', { plex_key: '1', mbid: 'not-an-mbid' }),
    post('/api/suggestions/hide', { kind: 'artist' }),
    route('GET', u('/api/lyrics/tracks')),
    route('GET', u('/api/search/details?kind=artist&id=abc')),
    post('/api/refresh', { job: 'everything' }),
  ])) {
    assert.equal(r.status, 400);
    assert.equal(typeof json(r).error, 'string');
  }
});

test('a body that is not JSON is a 500 with the reason, not a crash', async () => {
  const r = await route('POST', u('/api/settings'), '{not json');
  assert.equal(r.status, 500);
  assert.equal(json(r).error, 'Request body was not valid JSON');
});
