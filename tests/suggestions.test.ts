import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankRecentFirst,
  tvCandidate,
  movieCandidate,
  tmdbPoster,
  type Suggestion,
} from '../src/suggestions.ts';

const THIS_YEAR = 2026;

function cand(over: Partial<Suggestion> = {}): Suggestion {
  return {
    kind: 'movie',
    id: `tmdb://movie/${Math.random().toString(36).slice(2)}`,
    title: 'A Film',
    subtitle: '',
    year: 2026,
    score: 1,
    seeds: ['Something'],
    link: null,
    thumb: null,
    overview: '',
    rating_key: null,
    tracked: false,
    ...over,
  };
}

const titles = (rows: Suggestion[]) => rows.map((r) => r.title);

test('a recent film outranks an older one that scores higher', () => {
  const rows = rankRecentFirst(
    [cand({ title: 'Old', year: 1998, score: 9 }), cand({ title: 'New', year: 2026, score: 1 })],
    THIS_YEAR,
  );
  assert.deepEqual(titles(rows), ['New', 'Old']);
});

test('score still decides the order within the recent group', () => {
  const rows = rankRecentFirst(
    [cand({ title: 'Quiet', year: 2026, score: 2 }), cand({ title: 'Loud', year: 2027, score: 7 })],
    THIS_YEAR,
  );
  assert.deepEqual(titles(rows), ['Loud', 'Quiet']);
});

test('score still decides the order within the older group', () => {
  const rows = rankRecentFirst(
    [cand({ title: 'Faint', year: 1998, score: 1 }), cand({ title: 'Strong', year: 2001, score: 8 })],
    THIS_YEAR,
  );
  assert.deepEqual(titles(rows), ['Strong', 'Faint']);
});

test('a film with no year ranks with the recent ones', () => {
  const rows = rankRecentFirst(
    [cand({ title: 'Dated', year: 2010, score: 9 }), cand({ title: 'Undated', year: null, score: 1 })],
    THIS_YEAR,
  );
  assert.deepEqual(titles(rows), ['Undated', 'Dated']);
});

test('older films are kept, not dropped, so the toggle has something to show', () => {
  const rows = rankRecentFirst(
    [cand({ title: 'Old', year: 1998 }), cand({ title: 'New', year: 2026 })],
    THIS_YEAR,
  );
  assert.equal(rows.length, 2);
});

/* ------------------------------------------------------- show suggestions */

test('a TMDB television result is named, where a film is titled', () => {
  const c = tvCandidate({ id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17' }, 'Seed');
  assert.equal(c!.title, 'Game of Thrones');
});

test('a show takes its year from the first air date', () => {
  const c = tvCandidate({ id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17' }, 'Seed');
  assert.equal(c!.year, 2011);
});

test('a show that has not aired yet has no year rather than a wrong one', () => {
  const c = tvCandidate({ id: 1, name: 'Not Yet' }, 'Seed');
  assert.equal(c!.year, null);
});

test('a show is filed under show, not movie', () => {
  assert.equal(tvCandidate({ id: 1, name: 'A Show' }, 'Seed')!.kind, 'show');
});

test('a show id cannot collide with a film id', () => {
  const show = tvCandidate({ id: 550, name: 'A Show' }, 'Seed')!;
  assert.notEqual(show.id, 'tmdb://movie/550');
  assert.equal(show.id, 'tmdb://show/550');
});

test('the seed that produced it is recorded, so the card can say why', () => {
  assert.deepEqual(tvCandidate({ id: 1, name: 'A Show' }, 'Yellowstone')!.seeds, ['Yellowstone']);
});

test('a result with no id or no name is skipped rather than half built', () => {
  assert.equal(tvCandidate({ name: 'No Id' }, 'Seed'), null);
  assert.equal(tvCandidate({ id: 1 }, 'Seed'), null);
});

/* ------------------------------------------------- pictures and synopsis */

test('a TMDB poster path becomes a full image URL', () => {
  assert.equal(tmdbPoster('/abc.jpg'), 'https://image.tmdb.org/t/p/w342/abc.jpg');
});

test('no poster path means no picture, not a URL ending in null', () => {
  assert.equal(tmdbPoster(null), null);
  assert.equal(tmdbPoster(undefined), null);
  assert.equal(tmdbPoster(''), null);
});

/**
 * TMDB sends the path with its leading slash, but a missing one would quietly
 * produce a URL one directory up, which 404s rather than failing loudly.
 */
test('a poster path that arrives without its slash still resolves', () => {
  assert.equal(tmdbPoster('abc.jpg'), 'https://image.tmdb.org/t/p/w342/abc.jpg');
});

test('a film keeps its poster and its synopsis', () => {
  const c = movieCandidate(
    { id: 718821, title: 'Twisters', release_date: '2024-07-10', overview: 'Storm chasers.', poster_path: '/t.jpg' },
    'Twister',
  )!;
  assert.equal(c.thumb, 'https://image.tmdb.org/t/p/w342/t.jpg');
  assert.equal(c.overview, 'Storm chasers.');
});

test('a film is titled and dated from its release date', () => {
  const c = movieCandidate({ id: 1, title: 'A Film', release_date: '2024-07-10' }, 'Seed')!;
  assert.equal(c.title, 'A Film');
  assert.equal(c.year, 2024);
  assert.equal(c.kind, 'movie');
  assert.equal(c.id, 'tmdb://movie/1');
});

test('a film id cannot collide with a show id', () => {
  assert.notEqual(movieCandidate({ id: 550, title: 'A Film' }, 'Seed')!.id, 'tmdb://show/550');
});

test('a film result with no id or no title is skipped rather than half built', () => {
  assert.equal(movieCandidate({ title: 'No Id' }, 'Seed'), null);
  assert.equal(movieCandidate({ id: 1 }, 'Seed'), null);
});

test('a film with no synopsis carries an empty one, not the word undefined', () => {
  assert.equal(movieCandidate({ id: 1, title: 'A Film' }, 'Seed')!.overview, '');
  assert.equal(movieCandidate({ id: 1, title: 'A Film' }, 'Seed')!.thumb, null);
});

test('a show keeps its poster and its synopsis too', () => {
  const c = tvCandidate(
    { id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17', overview: 'Nine families.', poster_path: '/g.jpg' },
    'Seed',
  )!;
  assert.equal(c.thumb, 'https://image.tmdb.org/t/p/w342/g.jpg');
  assert.equal(c.overview, 'Nine families.');
});

test('a show with no synopsis carries an empty one', () => {
  const c = tvCandidate({ id: 1, name: 'A Show' }, 'Seed')!;
  assert.equal(c.overview, '');
  assert.equal(c.thumb, null);
});
