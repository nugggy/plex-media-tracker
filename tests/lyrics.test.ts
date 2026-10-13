import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lyricCounts, visibleLyricTracks } from '../public/feed.js';
import { hasLyricsStream } from '../src/plex.ts';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-lyrics-'));
const {
  fromLrclib,
  pickCandidate,
  DURATION_TOLERANCE_S,
  saveLyric,
  getLyric,
  trackStates,
} = await import('../src/lyrics.ts');

const TRACK = {
  rating_key: '22865',
  title: 'High Road',
  artist: 'Zach Bryan',
  album: 'American Heartbreak',
  duration_ms: 200_019,
  covered: false,
};

/* ------------------------------------------------------ LRCLIB responses */

test('synced lyrics are preferred, and plain kept alongside', () => {
  const got = fromLrclib({ plainLyrics: 'words', syncedLyrics: '[00:01.00] words', instrumental: false });
  assert.deepEqual(got, { synced: '[00:01.00] words', plain: 'words', instrumental: false });
});

test('plain lyrics are used when there is no synced lyric', () => {
  const got = fromLrclib({ plainLyrics: 'words', syncedLyrics: null, instrumental: false });
  assert.deepEqual(got, { synced: null, plain: 'words', instrumental: false });
});

test('an instrumental is stored as instrumental, not as a lyric', () => {
  const got = fromLrclib({ plainLyrics: '', syncedLyrics: '', instrumental: true });
  assert.deepEqual(got, { synced: null, plain: null, instrumental: true });
});

test('a response with nothing in it is not a lyric', () => {
  assert.equal(fromLrclib({ plainLyrics: '', syncedLyrics: '', instrumental: false }), null);
  assert.equal(fromLrclib({}), null);
});

/* ------------------------------------------------------ search candidates */

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 1,
  trackName: 'High Road',
  artistName: 'Zach Bryan',
  albumName: 'Zach Bryan',
  duration: 200,
  instrumental: false,
  plainLyrics: 'words',
  syncedLyrics: null,
  ...over,
});

test('a candidate within the tolerance is accepted', () => {
  const c = candidate({ duration: 200 + DURATION_TOLERANCE_S });
  assert.equal(pickCandidate(TRACK, [c]), c);
});

test('a candidate ten seconds out is refused, since it is a different recording', () => {
  assert.equal(pickCandidate(TRACK, [candidate({ duration: 210 })]), null);
});

test('a candidate by another artist is refused even when the title matches', () => {
  assert.equal(pickCandidate(TRACK, [candidate({ artistName: 'Someone Else' })]), null);
});

test('artist matching ignores case and punctuation', () => {
  const c = candidate({ artistName: 'zach  bryan' });
  assert.equal(pickCandidate(TRACK, [c]), c);
});

test('the closest duration wins when several fit', () => {
  const near = candidate({ id: 2, duration: 200.5 });
  const far = candidate({ id: 3, duration: 202 });
  assert.equal(pickCandidate(TRACK, [far, near]), near);
});

test('a track with no known duration takes the first candidate by the right artist', () => {
  const c = candidate({ duration: 340 });
  assert.equal(pickCandidate({ ...TRACK, duration_ms: null }, [c]), c);
});

test('a candidate with no duration is passed over when the track has one', () => {
  const unknown = candidate({ id: 4, duration: undefined });
  const near = candidate({ id: 5, duration: 201 });
  assert.equal(pickCandidate(TRACK, [unknown]), null);
  assert.equal(pickCandidate(TRACK, [unknown, near]), near);
});

test('a track with no known duration still takes a candidate with none', () => {
  const unknown = candidate({ duration: undefined });
  assert.equal(pickCandidate({ ...TRACK, duration_ms: null }, [unknown]), unknown);
});

/* ------------------------------------------------------------------ storage */

test('the old misses table is dropped, since nothing reads it any more', async () => {
  const { db } = await import('../src/db.ts');
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lyrics_misses'").get();
  assert.equal(row, undefined);
});

test('a lyric is stored and read back, and replaces an earlier one', () => {
  saveLyric(TRACK, { synced: null, plain: 'first', instrumental: false }, 'lrclib');
  assert.equal(getLyric('22865')?.plain, 'first');
  saveLyric(TRACK, { synced: '[00:01.00] second', plain: 'second', instrumental: false }, 'manual');
  const got = getLyric('22865');
  assert.equal(got?.synced, '[00:01.00] second');
  assert.equal(got?.source, 'manual');
  assert.equal(getLyric('nobody'), undefined);
});

test('each track is covered, stored, instrumental or missing', () => {
  saveLyric({ ...TRACK, rating_key: 'inst' }, { synced: null, plain: null, instrumental: true }, 'lrclib');
  const states = trackStates([
    { ...TRACK, rating_key: 'cov', covered: true },
    { ...TRACK, rating_key: '22865' },
    { ...TRACK, rating_key: 'inst' },
    { ...TRACK, rating_key: 'none' },
  ]);
  assert.deepEqual(
    states.map((t) => [t.rating_key, t.state]),
    [
      ['cov', 'covered'],
      ['22865', 'stored'],
      ['inst', 'instrumental'],
      ['none', 'missing'],
    ],
  );
});

/* --------------------------------------------------------- the page's counts */

test('the summary counts covered, stored and missing, with instrumentals as neither', () => {
  const counts = lyricCounts([
    { state: 'covered' },
    { state: 'covered' },
    { state: 'stored' },
    { state: 'instrumental' },
    { state: 'missing' },
  ]);
  assert.deepEqual(counts, { covered: 2, stored: 1, missing: 1, instrumental: 1, total: 5 });
});

test('Missing only hides everything but the tracks with no lyrics anywhere', () => {
  const tracks = [
    { rating_key: '1', state: 'covered' },
    { rating_key: '2', state: 'stored' },
    { rating_key: '3', state: 'instrumental' },
    { rating_key: '4', state: 'missing' },
  ];
  assert.deepEqual(visibleLyricTracks(tracks, false), tracks);
  assert.deepEqual(visibleLyricTracks(tracks, true).map((t) => t.rating_key), ['4']);
});

/* --------------------------------------------------- reading Plex's streams */

test('a track is covered only when a part carries a type 4 stream', () => {
  const part = (...types: number[]) => ({ Stream: types.map((streamType) => ({ streamType })) });
  assert.equal(hasLyricsStream({ Media: [{ Part: [part(2, 4)] }] }), true);
  assert.equal(hasLyricsStream({ Media: [{ Part: [part(2)] }] }), false);
  // The list endpoints leave the streams out altogether: that is unknown, not covered.
  assert.equal(hasLyricsStream({ Media: [{ Part: [{}] }] }), false);
  assert.equal(hasLyricsStream({}), false);
});
