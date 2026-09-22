import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppleChart, pickArtistMatch, mergeHidden, albumInLibrary } from '../src/trending.ts';

/** An album entry. Apple gives albums a single link object. */
const albumEntry = {
  'im:name': { label: "That's Just Me" },
  'im:artist': { label: 'Riley Green' },
  'im:image': [
    { label: 'https://is1-ssl.mzstatic.com/a/55x55bb.png', attributes: { height: '55' } },
    { label: 'https://is1-ssl.mzstatic.com/a/170x170bb.png', attributes: { height: '170' } },
  ],
  'im:releaseDate': { label: '2026-09-18T00:00:00-07:00' },
  id: { attributes: { 'im:id': '6770725355' } },
  link: { attributes: { href: 'https://music.apple.com/us/album/thats-just-me/6770725355' } },
};

/** A song entry. Apple gives songs an array of links instead. */
const songEntry = {
  ...albumEntry,
  link: [{ attributes: { href: 'https://music.apple.com/us/album/last-thing/6812476961' } }],
};

const feed = (entries: unknown[]) => ({ feed: { entry: entries } });

test('an album entry becomes a chart row', () => {
  const rows = parseAppleChart(feed([albumEntry]), 'album');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "That's Just Me");
  assert.equal(rows[0]!.subtitle, 'Riley Green');
  assert.equal(rows[0]!.kind, 'album');
});

test('chart position is kept, counting from one', () => {
  const rows = parseAppleChart(feed([albumEntry, songEntry]), 'album');
  assert.deepEqual(rows.map((r) => r.rank), [1, 2]);
});

test('the release date is reduced to a plain calendar date', () => {
  assert.equal(parseAppleChart(feed([albumEntry]), 'album')[0]!.release_date, '2026-09-18');
});

test('the largest artwork is chosen, not the first', () => {
  assert.equal(
    parseAppleChart(feed([albumEntry]), 'album')[0]!.thumb,
    'https://is1-ssl.mzstatic.com/a/170x170bb.png',
  );
});

test('artwork is chosen by height even when out of size order', () => {
  const outOfOrder = {
    ...albumEntry,
    'im:image': [
      { label: 'https://is1-ssl.mzstatic.com/a/170x170bb.png', attributes: { height: '170' } },
      { label: 'https://is1-ssl.mzstatic.com/a/55x55bb.png', attributes: { height: '55' } },
      { label: 'https://is1-ssl.mzstatic.com/a/100x100bb.png', attributes: { height: '100' } },
    ],
  };
  assert.equal(
    parseAppleChart(feed([outOfOrder]), 'album')[0]!.thumb,
    'https://is1-ssl.mzstatic.com/a/170x170bb.png',
  );
});

test('a song link arrives as an array where an album link is an object', () => {
  const album = parseAppleChart(feed([albumEntry]), 'album')[0]!;
  const song = parseAppleChart(feed([songEntry]), 'single')[0]!;
  assert.equal(album.link, 'https://music.apple.com/us/album/thats-just-me/6770725355');
  assert.equal(song.link, 'https://music.apple.com/us/album/last-thing/6812476961');
});

test('an entry with no title is skipped rather than throwing', () => {
  assert.equal(parseAppleChart(feed([{ 'im:artist': { label: 'Someone' } }]), 'album').length, 0);
});

test('a feed with no entries yields nothing rather than throwing', () => {
  assert.deepEqual(parseAppleChart({ feed: {} }, 'album'), []);
  assert.deepEqual(parseAppleChart(null, 'album'), []);
});

test('missing id falls back to combining title and artist for stability', () => {
  const noId = { ...albumEntry, id: undefined };
  const rows = parseAppleChart(feed([noId]), 'album');
  assert.equal(rows[0]!.id, "That's Just Me|Riley Green");
});

test('null elements in the array are skipped rather than throwing', () => {
  const rows = parseAppleChart(feed([albumEntry, null, songEntry]), 'album');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.title), ["That's Just Me", "That's Just Me"]);
});

/* ------------------------------------------------------- artist resolution */

const mb = (name: string, score = 100, id = name.toLowerCase()) => ({ id, name, score });

test('the artist whose name matches is chosen', () => {
  const picked = pickArtistMatch([mb('Someone Else'), mb('Riley Green')], 'Riley Green');
  assert.equal(picked, 'riley green');
});

test('case and punctuation in the chart name do not matter', () => {
  assert.equal(pickArtistMatch([mb('Morgan Wallen')], 'MORGAN WALLEN!'), 'morgan wallen');
});

test('a weak MusicBrainz score is refused rather than guessed at', () => {
  assert.equal(pickArtistMatch([mb('Riley Green', 40)], 'Riley Green'), null);
});

test('no candidate at all gives nothing rather than throwing', () => {
  assert.equal(pickArtistMatch([], 'Riley Green'), null);
});

test('a name that does not match is refused even when it scores well', () => {
  assert.equal(pickArtistMatch([mb('Riley Greene')], 'Riley Green'), null);
});

test('a score exactly on the threshold is accepted', () => {
  assert.equal(pickArtistMatch([mb('Riley Green', 70)], 'Riley Green'), 'riley green');
});

test('a score one below the threshold is refused', () => {
  assert.equal(pickArtistMatch([mb('Riley Green', 69)], 'Riley Green'), null);
});

/* ------------------------------------------------------------ hidden rows */

const stored = (over: Record<string, unknown> = {}) => ({
  kind: 'album',
  id: '1',
  rank: 1,
  title: 'A Record',
  subtitle: 'An Artist',
  release_date: '2026-09-01',
  thumb: null,
  link: null,
  rating_key: null,
  guid: null,
  mbid: null,
  tracked: false,
  in_library: false,
  ...over,
});

test('a row the user hid is dropped after a rebuild', () => {
  const rows = mergeHidden([stored()], new Set(['album:1']));
  assert.equal(rows.length, 0);
});

test('hiding one row leaves the others alone', () => {
  const rows = mergeHidden([stored(), stored({ id: '2' })], new Set(['album:1']));
  assert.deepEqual(rows.map((r) => r.id), ['2']);
});

test('the same id under a different kind is a different row', () => {
  const rows = mergeHidden([stored({ kind: 'single' })], new Set(['album:1']));
  assert.equal(rows.length, 1);
});

/* ------------------------------------------------------- album ownership */

// Raw, unnormalised titles, exactly as plex_albums.title holds them: the
// ownership check normalises them itself, and it needs the original bracket
// text to do that (see the LibraryArtist comment in src/trending.ts).
const realArtist = (titles: string[]) => ({
  plexKey: '12345',
  albumTitles: new Set(titles),
});

test('a title that only differs by case and punctuation still matches', () => {
  const artist = realArtist(['One Thing At A Time']);
  assert.equal(albumInLibrary("ONE THING AT A TIME!!", artist), true);
});

test('a deluxe edition in the library matches the plain chart title', () => {
  const artist = realArtist(['Chief (Deluxe Edition)']);
  assert.equal(albumInLibrary('Chief', artist), true);
});

test('a remastered edition in the library matches the plain chart title', () => {
  const artist = realArtist(['Chief (Remastered)']);
  assert.equal(albumInLibrary('Chief', artist), true);
});

// The actual finding this change fixes: a live album, or a soundtrack, is
// not the studio record the chart is naming, and must not tick as owned.
test('a live album in the library does NOT match the plain chart title', () => {
  const artist = realArtist(['Chief (Live)']);
  assert.equal(albumInLibrary('Chief', artist), false);
});

test('a soundtrack in the library does NOT match the plain chart title', () => {
  const artist = realArtist(['Golden Hour (Original Soundtrack)']);
  assert.equal(albumInLibrary('Golden Hour', artist), false);
});

test('an artist with no albums at all never matches', () => {
  const artist = realArtist([]);
  assert.equal(albumInLibrary('Chief', artist), false);
});

test('a chart title with no matching album in the library is refused', () => {
  const artist = realArtist(['Chief', 'If I Know Me']);
  assert.equal(albumInLibrary('One Thing At A Time', artist), false);
});

test('no resolved artist at all, standing in for a null mbid, is refused', () => {
  assert.equal(albumInLibrary('Chief', null), false);
});

test('a manually watched artist is refused even if it somehow carries album rows', () => {
  const artist = { plexKey: 'manual:abc123', albumTitles: new Set(['Chief']) };
  assert.equal(albumInLibrary('Chief', artist), false);
});
