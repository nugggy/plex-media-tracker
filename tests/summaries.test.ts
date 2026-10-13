import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Points the app at a throwaway folder before anything opens the database.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-summaries-'));
const { route } = await import('../src/route.ts');
const store = await import('../src/db.ts');
const { db } = store;
const { saveLyric, recordLyricFile } = await import('../src/lyrics.ts');
const { rememberTrackCount } = await import('../src/dash.ts');
const { upcomingWeekCount } = await import('../src/api.ts');
const { today, shiftDate } = await import('../src/dates.ts');

const json = (r: { body: Uint8Array }) => JSON.parse(new TextDecoder().decode(r.body));
const get = async (p: string) => json(await route('GET', new URL(`http://app${p}`)));
const post = (p: string, body: unknown) => route('POST', new URL(`http://app${p}`), JSON.stringify(body));

/* ------------------------------------------------------- lyrics summary */

const track = (key: string) => ({
  rating_key: key, title: `Song ${key}`, artist: 'A', album: null, duration_ms: null, covered: false,
});

test('the lyrics summary counts stored lyrics and saved files, with no track count yet', async () => {
  saveLyric(track('1'), { synced: '[00:01.00]la', plain: null, instrumental: false }, 'lrclib');
  saveLyric(track('2'), { synced: null, plain: 'words', instrumental: false }, 'manual');
  saveLyric(track('3'), { synced: null, plain: null, instrumental: true }, 'lrclib');
  recordLyricFile('1', 'C:/music/a/1.lrc');
  assert.deepEqual(await get('/api/lyrics/summary'), { tracks: null, with_lyrics: 2, saved_to_plex: 1 });
});

test('the summary gives the music library\'s track count once one has been read', async () => {
  store.setSetting('plex_section', '6');
  rememberTrackCount(14_250);
  assert.equal((await get('/api/lyrics/summary')).tracks, 14_250);
});

test('a count read from another library is not passed off as this one\'s', async () => {
  store.setSetting('plex_section', '7');
  assert.equal((await get('/api/lyrics/summary')).tracks, null);
  store.setSetting('plex_section', '6');
});

/* ------------------------------------------------------ library artwork */

test('worth-upgrading films carry artwork in the releases feed\'s form', async () => {
  db.prepare(
    `INSERT INTO library_guids (guid, type, title, year, rating_key, file_count, resolution)
     VALUES ('plex://movie/a', 'movie', 'Low Res', 2001, '3084', 1, '720'),
            ('plex://movie/b', 'movie', 'No Key', 2002, NULL, 1, 'sd'),
            ('plex://movie/c', 'movie', 'Twice', 2003, '3090', 2, '1080')`,
  ).run();
  const report = await get('/api/library');
  const byTitle = Object.fromEntries(report.upgrades.map((u: { title: string }) => [u.title, u]));
  assert.equal(byTitle['Low Res'].thumb, '/thumb?key=3084');
  assert.equal(byTitle['No Key'].thumb, null);
  assert.equal(report.duplicates[0].thumb, '/thumb?key=3090');
});

test('the thumbnail proxy takes a library key, and refuses one that is not a plain number', async () => {
  // No server is saved, so a real key finds nothing to fetch, but it is a
  // clean 404 rather than an error, and a crafted key never gets that far.
  assert.equal((await route('GET', new URL('http://app/thumb?key=3084'))).status, 404);
  assert.equal((await route('GET', new URL('http://app/thumb?key=..%2F..%2Fstatus'))).status, 404);
});

/* --------------------------------------------------------------- trending */

test('trending says whether the charts are stale and whether one is building', async () => {
  const body = await get('/api/trending');
  assert.equal(body.stale, true);
  // Plex is not set up here, so nothing was started automatically.
  assert.equal(body.building, false);
  assert.deepEqual(body.built_at, { movie: null, show: null, album: null });
});

/* ----------------------------------------------------- partial settings */

test('a partial settings save leaves every other setting as it was', async () => {
  await post('/api/settings', {
    plex_url: 'http://nas:32400',
    plex_token: 'secret-token',
    tmdb_api_key: 'secret-key',
    recent_days: '60',
    include_ep: '1',
    sync_on_start: '1',
  });
  const before = store.getSettings();

  // The feed section alone, as the page now saves it.
  const r = await post('/api/settings', { recent_days: '90', include_ep: '0' });
  assert.equal(r.status, 200);
  const after = store.getSettings();
  assert.equal(after.recent_days, '90');
  assert.equal(after.include_ep, '0');
  for (const key of Object.keys(before)) {
    if (key === 'recent_days' || key === 'include_ep') continue;
    assert.equal(after[key], before[key], key);
  }
  assert.equal(after.plex_token, 'secret-token');
  assert.equal(after.tmdb_api_key, 'secret-key');
});

test('a section saved with the masked secrets in it keeps the real ones', async () => {
  await post('/api/settings', { plex_url: 'http://other:32400', plex_token: '********' });
  await post('/api/settings', { tmdb_api_key: '********' });
  assert.equal(store.getSetting('plex_url'), 'http://other:32400');
  assert.equal(store.getSetting('plex_token'), 'secret-token');
  assert.equal(store.getSetting('tmdb_api_key'), 'secret-key');
});

/* ------------------------------------------------------------ state badges */

test('state reports the week ahead and the artist counts beside the old fields', async () => {
  const day = (n: number) => shiftDate(today(), n);
  store.upsertArtist({ plex_key: '10', name: 'On', sort_name: 'On', thumb: null, album_count: 1, mbid: 'm-on' });
  store.upsertArtist({ plex_key: '11', name: 'Off', sort_name: 'Off', thumb: null, album_count: 1, mbid: 'm-off' });
  store.setArtistMuted('11', true);
  const rel = (id: string, date: string, owned = false) =>
    store.upsertRelease({
      mb_id: id, plex_key: '10', title: id, norm_title: id, primary_type: 'Album',
      secondary_types: null, release_date: date, owned,
    });
  rel('soon', day(3));
  rel('held-soon', day(5), true);
  rel('week-end', day(7));
  rel('later', day(8));

  const { counts } = await get('/api/state');
  assert.equal(counts.upcoming, 4);
  // Held records still show in Coming soon by default, so they count.
  assert.equal(counts.upcoming_week, 3);
  assert.equal(counts.artists, 1);
  assert.equal(counts.artists_active, 1);
  assert.equal(counts.artists_present, 2);
});

test('the week count drops cinema-only films and folds a show\'s episodes into one row', () => {
  const from = '2026-10-13';
  const row = (over: Record<string, unknown>) => ({
    source: 'music', kind: 'album', id: 'x', title: 't', subtitle: 's', date: '2026-10-14',
    event: null, thumb: null, link: null, first_seen_at: '', dismissed: 0, in_library: 0, ...over,
  });
  const rows = [
    row({ id: 'a' }),
    row({ id: 'cinema', source: 'watchlist', kind: 'movie', date_kind: 'cinema' }),
    row({ id: 'digital', source: 'watchlist', kind: 'movie', date_kind: 'digital' }),
    row({ id: 'e1', source: 'episode', kind: 'show', group: 'show-1' }),
    row({ id: 'e2', source: 'episode', kind: 'show', group: 'show-1', date: '2026-10-15' }),
    row({ id: 'e3', source: 'episode', kind: 'show', group: 'show-2' }),
    row({ id: 'single', kind: 'single' }),
    row({ id: 'late', date: '2026-10-21' }),
  ];
  assert.equal(upcomingWeekCount(rows as never, from), 4);
});
