import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database and a stubbed MusicBrainz. The clock is mocked because
// the MusicBrainz client spaces its requests over a second apart.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-scanner-'));
const store = await import('../src/db.ts');
const { identifyArtist, checkArtistReleases, isWanted, wantedTypes } = await import('../src/scanner.ts');
type ArtistRow = import('../src/db.ts').ArtistRow;
type MbReleaseGroup = import('../src/musicbrainz.ts').MbReleaseGroup;

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-13T00:00:00Z') });

/** Answers by path: the artist search, or one artist's release groups. */
let searchAnswer: unknown[] = [];
const groupsByArtist = new Map<string, unknown[]>();
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const body =
    url.pathname.endsWith('/artist')
      ? { artists: searchAnswer }
      : (() => {
          const groups = groupsByArtist.get(url.searchParams.get('artist') ?? '') ?? [];
          return { 'release-groups': groups, 'release-group-count': groups.length };
        })();
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 2_000 && !done; i += 1) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(100);
  }
  return p;
}

function artist(key: string, name: string, mbid: string | null = null): ArtistRow {
  store.upsertArtist({ plex_key: key, name, sort_name: name, thumb: null, album_count: 1, mbid });
  return store.getArtist(key)!;
}

const group = (over: Partial<MbReleaseGroup> = {}): MbReleaseGroup => ({
  id: 'rg',
  title: 'Title',
  primaryType: 'Album',
  secondaryTypes: [],
  firstReleaseDate: '2026-10-01',
  datePrecision: 'day',
  ...over,
});

/* ---------------------------------------------------------- what is wanted */

test('albums and EPs are wanted, singles never are', () => {
  const wanted = wantedTypes({ include_album: '1', include_ep: '1', include_single: '1' });
  assert.deepEqual([...wanted].sort(), ['album', 'ep']);
  assert.equal(isWanted(group({ primaryType: 'Album' }), wanted), true);
  assert.equal(isWanted(group({ primaryType: 'EP' }), wanted), true);
  assert.equal(isWanted(group({ primaryType: 'Single' }), wanted), false);
  // Even if a caller hands in a set with singles in it.
  assert.equal(isWanted(group({ primaryType: 'Single' }), new Set(['single'])), false);
});

test('live albums, compilations and the like are left out', () => {
  assert.equal(isWanted(group({ secondaryTypes: ['Live'] }), new Set(['album'])), false);
  assert.equal(isWanted(group({ primaryType: null }), new Set(['album'])), false);
});

test('switching albums off in Settings leaves only EPs', () => {
  assert.deepEqual([...wantedTypes({ include_album: '0', include_ep: '1' })], ['ep']);
});

/* --------------------------------------------------------- identifying */

test('one exact match is taken as the artist', async () => {
  searchAnswer = [
    { id: 'mb-1', name: 'Riley Green', score: 100 },
    { id: 'mb-x', name: 'Riley Greene', score: 90 },
  ];
  await settle(identifyArtist(artist('p1', 'Riley Green')));
  const row = store.getArtist('p1')!;
  assert.equal(row.mbid, 'mb-1');
  assert.equal(row.mb_status, 'resolved');
});

test('no confident match is recorded as not found', async () => {
  searchAnswer = [{ id: 'mb-2', name: 'Someone Else', score: 100 }];
  await settle(identifyArtist(artist('p2', 'Nobody Known')));
  assert.equal(store.getArtist('p2')!.mb_status, 'not_found');
});

test('two artists of the same name are told apart by the albums already held', async () => {
  searchAnswer = [
    { id: 'mb-a', name: 'Alabama', score: 100 },
    { id: 'mb-b', name: 'Alabama', score: 100 },
  ];
  groupsByArtist.set('mb-a', [{ id: 'g1', title: 'Some Other Record', 'primary-type': 'Album' }]);
  groupsByArtist.set('mb-b', [{ id: 'g2', title: 'Mountain Music', 'primary-type': 'Album' }]);
  const row = artist('p3', 'Alabama');
  store.replacePlexAlbums([
    { plex_key: 'al3', artist_key: 'p3', title: 'Mountain Music', norm_title: 'mountain music', year: 1982 },
  ]);
  await settle(identifyArtist(row));
  assert.equal(store.getArtist('p3')!.mbid, 'mb-b');
});

test('a tie the library cannot break is left for the user to choose', async () => {
  searchAnswer = [
    { id: 'mb-c', name: 'Exile', score: 100 },
    { id: 'mb-d', name: 'Exile', score: 100 },
  ];
  await settle(identifyArtist(artist('p4', 'Exile')));
  const row = store.getArtist('p4')!;
  assert.equal(row.mb_status, 'ambiguous');
  assert.equal(JSON.parse(row.mb_candidates!).length, 2);
});

/* ------------------------------------------------------ release checks */

test('a release check stores albums and EPs, skips singles, and counts only new ones', async () => {
  const row = artist('p5', 'Zach Bryan', 'mb-zb');
  store.replacePlexAlbums([
    { plex_key: 'al5', artist_key: 'p5', title: 'Held Record', norm_title: 'held record', year: 2026 },
  ]);
  groupsByArtist.set('mb-zb', [
    { id: 'z1', title: 'New Album', 'primary-type': 'Album', 'first-release-date': '2026-10-01' },
    { id: 'z2', title: 'Next EP', 'primary-type': 'EP', 'first-release-date': '2026-11' },
    { id: 'z3', title: 'A Single', 'primary-type': 'Single', 'first-release-date': '2026-10-02' },
    { id: 'z4', title: 'Held Record', 'primary-type': 'Album', 'first-release-date': '2026-09-01' },
    { id: 'z5', title: 'Live at Home', 'primary-type': 'Album', 'secondary-types': ['Live'] },
  ]);
  const wanted = new Set(['album', 'ep']);
  assert.equal(await settle(checkArtistReleases(row, wanted)), 2);

  const stored = store.db
    .prepare("SELECT mb_id, release_date, date_precision, owned FROM releases WHERE plex_key = 'p5' ORDER BY mb_id")
    .all();
  assert.deepEqual(
    stored.map((r) => ({ ...r })),
    [
      { mb_id: 'z1', release_date: '2026-10-01', date_precision: 'day', owned: 0 },
      { mb_id: 'z2', release_date: '2026-11-30', date_precision: 'month', owned: 0 },
      { mb_id: 'z4', release_date: '2026-09-01', date_precision: 'day', owned: 1 },
    ],
  );

  // A second look finds nothing new.
  assert.equal(await settle(checkArtistReleases(row, wanted)), 0);
});

test('an EP announced for next month waits in Coming soon, not Out now', () => {
  const upcoming = store.feed('upcoming', 180).map((r) => r.mb_id);
  const out = store.feed('out', 180).map((r) => r.mb_id);
  assert.ok(upcoming.includes('z2'));
  assert.ok(!out.includes('z2'));
  assert.ok(out.includes('z1'));
});

/* ---------------------------------------------------- absent artists */

test('an empty artist list from Plex marks nobody as gone', () => {
  artist('p6', 'Still Here');
  assert.equal(store.markAbsentArtists([]), -1);
  assert.equal(store.getArtist('p6')!.present, 1);
});

test('artists missing from a real list are marked gone, manual ones are not', () => {
  store.db.exec(`INSERT OR REPLACE INTO artists (plex_key, name, present) VALUES ('manual:x', 'Watched', 1)`);
  const absent = store.markAbsentArtists(['p6']);
  assert.ok(absent > 0);
  assert.equal(store.getArtist('p6')!.present, 1);
  assert.equal(store.getArtist('p1')!.present, 0);
  assert.equal(store.getArtist('manual:x')!.present, 1);
});

/* -------------------------------------------------------- migrations */

test('a data fix runs once only, and a failing one leaves no trace', () => {
  let runs = 0;
  store.runOnce('test-fix', () => {
    runs += 1;
  });
  store.runOnce('test-fix', () => {
    runs += 1;
  });
  assert.equal(runs, 1);

  assert.throws(() =>
    store.runOnce('test-broken', () => {
      store.setSetting('half_done', '1');
      throw new Error('boom');
    }),
  );
  assert.equal(store.getSetting('half_done'), '');
  let retried = false;
  store.runOnce('test-broken', () => {
    retried = true;
  });
  assert.equal(retried, true);
});

test('singles are gone from the settings', () => {
  assert.equal('include_single' in store.getSettings(), false);
});
