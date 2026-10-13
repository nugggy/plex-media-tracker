import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A database holding the duplicate the merge exists for, written before the
// app opens it, so the one-off fix at start-up has something real to fold.
const dir = mkdtempSync(join(tmpdir(), 'pmt-artistmerge-'));
process.env.PLEX_TRACKER_DATA_DIR = dir;
const CITY = 'f556bd09-3164-4ea4-97da-7cddad59deaa';

{
  const old = new DatabaseSync(join(dir, 'plex-media-tracker.db'));
  old.exec(`
    CREATE TABLE artists (plex_key TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL DEFAULT '',
      thumb TEXT, mbid TEXT, mb_status TEXT NOT NULL DEFAULT 'pending', mb_candidates TEXT,
      muted INTEGER NOT NULL DEFAULT 0, album_count INTEGER NOT NULL DEFAULT 0, last_checked_at TEXT,
      last_error TEXT, present INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE releases (mb_id TEXT PRIMARY KEY, plex_key TEXT NOT NULL, title TEXT NOT NULL,
      norm_title TEXT NOT NULL, primary_type TEXT, secondary_types TEXT, release_date TEXT,
      owned INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE plex_albums (plex_key TEXT PRIMARY KEY, artist_key TEXT NOT NULL, title TEXT NOT NULL,
      norm_title TEXT NOT NULL, year INTEGER);
  `);
  old.exec(`
    INSERT INTO artists (plex_key, name, mbid, mb_status, muted, present) VALUES
      ('manual:${CITY}', 'Citycreed', '${CITY}', 'manual', 0, 1),
      ('45911', 'Citycreed', '${CITY}', 'resolved', 1, 1),
      ('manual:only-followed', 'Nobody In Plex', 'only-followed', 'manual', 0, 1);
    INSERT INTO releases (mb_id, plex_key, title, norm_title, primary_type, release_date, first_seen_at, dismissed) VALUES
      ('rg-held', 'manual:${CITY}', 'Held Album', 'held album', 'Album', '2026-09-01', '2026-09-01', 0),
      ('rg-dismissed', 'manual:${CITY}', 'Old EP', 'old ep', 'EP', '2026-08-01', '2026-08-01', 1);
    INSERT INTO plex_albums VALUES ('900', '45911', 'Held Album', 'held album', 2026);
  `);
  old.close();
}

const store = await import('../src/db.ts');
const { db } = store;
const { trackArtist } = await import('../src/search.ts');
const { route } = await import('../src/route.ts');

const artist = (key: string) => store.getArtist(key);
const release = (id: string) =>
  db.prepare('SELECT * FROM releases WHERE mb_id = ?').get(id) as
    | { plex_key: string; dismissed: number; owned: number }
    | undefined;

/* ----------------------------------------------------- the one-off fix */

test('the start-up fix folds a hand-followed artist into their Plex twin', () => {
  assert.equal(artist(`manual:${CITY}`), undefined);
  assert.ok(artist('45911'));
  assert.equal(
    store.allArtists().filter((a) => a.mbid === CITY).length,
    1,
    'Citycreed is listed once',
  );
});

test('their releases move across, keeping a dismissal, and pick up what Plex holds', () => {
  assert.equal(release('rg-held')!.plex_key, '45911');
  assert.equal(release('rg-held')!.owned, 1);
  assert.equal(release('rg-dismissed')!.plex_key, '45911');
  assert.equal(release('rg-dismissed')!.dismissed, 1);
});

test('an unmuted follow outranks a mute on the library copy', () => {
  assert.equal(artist('45911')!.muted, 0);
});

test('an artist followed by hand and not in Plex is left alone', () => {
  assert.ok(artist('manual:only-followed'));
});

/* ---------------------------------------------- after start-up, kept tidy */

const plexArtist = (key: string, mbid: string | null, muted = 0) => {
  store.upsertArtist({ plex_key: key, name: key, sort_name: key, thumb: null, album_count: 1, mbid });
  store.setArtistMuted(key, muted === 1);
};

test('a scan that brings a followed artist into Plex merges them', () => {
  trackArtist('mbid-later', 'Later');
  store.upsertRelease({
    mb_id: 'rg-later', plex_key: 'manual:mbid-later', title: 'T', norm_title: 't',
    primary_type: 'Album', secondary_types: null, release_date: '2026-11-01', owned: false,
  });
  plexArtist('5001', 'mbid-later');
  assert.equal(store.mergeManualArtists(), 1);
  assert.equal(artist('manual:mbid-later'), undefined);
  assert.equal(release('rg-later')!.plex_key, '5001');
});

test('a muted follow leaves the Plex row as it was', () => {
  db.prepare(
    `INSERT INTO artists (plex_key, name, sort_name, mbid, mb_status, muted, present)
     VALUES ('manual:mbid-muted', 'M', 'M', 'mbid-muted', 'manual', 1, 1)`,
  ).run();
  plexArtist('5002', 'mbid-muted', 0);
  store.mergeManualArtists();
  assert.equal(artist('manual:mbid-muted'), undefined);
  assert.equal(artist('5002')!.muted, 0);

  db.prepare(
    `INSERT INTO artists (plex_key, name, sort_name, mbid, mb_status, muted, present)
     VALUES ('manual:mbid-both', 'B', 'B', 'mbid-both', 'manual', 1, 1)`,
  ).run();
  plexArtist('5003', 'mbid-both', 1);
  store.mergeManualArtists();
  assert.equal(artist('5003')!.muted, 1);
});

test('a Plex artist no longer in the library does not swallow a follow', () => {
  trackArtist('mbid-gone', 'Gone');
  plexArtist('5004', 'mbid-gone');
  db.prepare("UPDATE artists SET present = 0 WHERE plex_key = '5004'").run();
  assert.equal(store.mergeManualArtists(), 0);
  assert.ok(artist('manual:mbid-gone'));
});

test('setting a Plex artist to a followed artist\'s ID by hand merges them', async () => {
  trackArtist('a1b2c3d4-0000-4000-8000-000000000001', 'Hand Set');
  plexArtist('5005', null);
  const r = await route(
    'POST',
    new URL('http://app/api/artists/mbid'),
    JSON.stringify({ plex_key: '5005', mbid: 'a1b2c3d4-0000-4000-8000-000000000001' }),
  );
  assert.equal(r.status, 200);
  assert.equal(artist('manual:a1b2c3d4-0000-4000-8000-000000000001'), undefined);
  assert.equal(artist('5005')!.mbid, 'a1b2c3d4-0000-4000-8000-000000000001');
});

/* -------------------------------------------------- following by search */

test('following an artist already in Plex adds no second row, and unmutes them', () => {
  plexArtist('5006', 'mbid-inplex', 1);
  trackArtist('mbid-inplex', 'In Plex');
  assert.equal(artist('manual:mbid-inplex'), undefined);
  assert.equal(artist('5006')!.muted, 0);
});

test('following an artist not in Plex still adds them by hand', () => {
  trackArtist('mbid-new', 'New');
  assert.equal(artist('manual:mbid-new')!.mb_status, 'manual');
});
