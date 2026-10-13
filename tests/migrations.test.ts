import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A database as an older version left it, written before the app opens it, so
// the start-up fixes have something real to work on.
const dir = mkdtempSync(join(tmpdir(), 'pmt-migrations-'));
process.env.PLEX_TRACKER_DATA_DIR = dir;
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 7); // the month of thirty days ago

{
  const old = new DatabaseSync(join(dir, 'plex-media-tracker.db'));
  old.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE artists (plex_key TEXT PRIMARY KEY, name TEXT NOT NULL, sort_name TEXT NOT NULL DEFAULT '',
      thumb TEXT, mbid TEXT, mb_status TEXT NOT NULL DEFAULT 'pending', mb_candidates TEXT,
      muted INTEGER NOT NULL DEFAULT 0, album_count INTEGER NOT NULL DEFAULT 0, last_checked_at TEXT,
      last_error TEXT, present INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE releases (mb_id TEXT PRIMARY KEY, plex_key TEXT NOT NULL, title TEXT NOT NULL,
      norm_title TEXT NOT NULL, primary_type TEXT, secondary_types TEXT, release_date TEXT,
      owned INTEGER NOT NULL DEFAULT 0, first_seen_at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trending_items (kind TEXT NOT NULL, id TEXT NOT NULL, rank INTEGER NOT NULL,
      title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', release_date TEXT, thumb TEXT, link TEXT,
      rating_key TEXT, guid TEXT, mbid TEXT, built_at TEXT NOT NULL, PRIMARY KEY (kind, id));
    CREATE TABLE trending_hidden (kind TEXT NOT NULL, id TEXT NOT NULL, hidden_at TEXT NOT NULL,
      PRIMARY KEY (kind, id));
    CREATE TABLE lyrics_misses (rating_key TEXT PRIMARY KEY, tried_at TEXT NOT NULL);
  `);
  old.exec(`
    INSERT INTO settings VALUES ('include_single', '1'), ('recent_days', '90');
    INSERT INTO artists (plex_key, name, last_checked_at) VALUES
      ('padded', 'Padded', '2026-10-01T00:00:00Z'),
      ('exact', 'Exact', '2026-10-01T00:00:00Z');
    INSERT INTO releases (mb_id, plex_key, title, norm_title, primary_type, release_date, first_seen_at) VALUES
      ('s1', 'exact', 'A Single', 'a single', 'Single', '2026-10-02', '2026-10-01'),
      ('a1', 'exact', 'An Album', 'an album', 'Album', '2026-10-02', '2026-10-01'),
      ('e1', 'padded', 'An EP', 'an ep', 'EP', '${recent}-01', '2026-10-01');
    INSERT INTO trending_items (kind, id, rank, title, built_at) VALUES
      ('single', '1', 1, 'Song', '2026-10-01'), ('album', '2', 1, 'Record', '2026-10-01');
    INSERT INTO trending_hidden VALUES ('single', '1', '2026-10-01'), ('album', '9', '2026-10-01');
  `);
  old.close();
}

const store = await import('../src/db.ts');
await import('../src/trending.ts');
await import('../src/lyrics.ts');
const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;

test('stored singles and the singles setting are removed, other records kept', () => {
  assert.equal(count("SELECT COUNT(*) AS n FROM releases WHERE primary_type = 'Single'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM releases WHERE mb_id IN ('a1', 'e1')"), 2);
  assert.equal(count("SELECT COUNT(*) AS n FROM settings WHERE key = 'include_single'"), 0);
  assert.equal(store.getSetting('recent_days'), '90');
});

test('the singles chart and anything hidden from it are cleared', () => {
  assert.equal(count("SELECT COUNT(*) AS n FROM trending_items WHERE kind = 'single'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM trending_hidden WHERE kind = 'single'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM trending_items WHERE kind = 'album'"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM trending_hidden WHERE kind = 'album'"), 1);
});

test('an artist with a possibly padded recent date is due for a fresh check', () => {
  assert.equal(store.getArtist('padded')!.last_checked_at, null);
  assert.equal(store.getArtist('exact')!.last_checked_at, '2026-10-01T00:00:00Z');
});

test('releases gain a column for how precise their date is', () => {
  const cols = store.db.prepare('PRAGMA table_info(releases)').all().map((c) => c.name);
  assert.ok(cols.includes('date_precision'));
});

test('the unused misses table is dropped', () => {
  assert.equal(count("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'lyrics_misses'"), 0);
});
