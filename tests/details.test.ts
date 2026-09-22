import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlexDetails, applyTmdbCredits, MAX_CAST } from '../src/details.ts';

/** The shape Plex Discover returns for one film or show. */
function plexPayload(meta: Record<string, unknown> = {}) {
  return {
    MediaContainer: {
      Metadata: [
        {
          summary: 'A drifter walks into town.',
          tagline: 'Everyone has a past.',
          duration: 7_260_000,
          contentRating: 'MA15+',
          audienceRating: 8.4,
          studio: 'A Studio',
          Genre: [{ tag: 'Drama' }, { tag: 'Western' }],
          Director: [{ tag: 'A Director' }],
          Role: [{ tag: 'An Actor', role: 'The Drifter' }],
          Guid: [{ id: 'imdb://tt0001' }, { id: 'tmdb://603' }],
          ...meta,
        },
      ],
    },
  };
}

/* ------------------------------------------------------------------ plex */

test('the synopsis is read out of the Plex payload', () => {
  assert.equal(parsePlexDetails(plexPayload())!.summary, 'A drifter walks into town.');
});

test('runtime comes back in whole minutes, not milliseconds', () => {
  assert.equal(parsePlexDetails(plexPayload())!.runtime_minutes, 121);
});

test('a missing duration gives no runtime rather than zero', () => {
  assert.equal(parsePlexDetails(plexPayload({ duration: undefined }))!.runtime_minutes, null);
});

test('cast comes back with the character each actor played', () => {
  assert.deepEqual(parsePlexDetails(plexPayload())!.cast, [
    { name: 'An Actor', role: 'The Drifter' },
  ]);
});

test('genres and directors are flattened to plain names', () => {
  const d = parsePlexDetails(plexPayload())!;
  assert.deepEqual(d.genres, ['Drama', 'Western']);
  assert.deepEqual(d.directors, ['A Director']);
});

test('the TMDB id is picked out of the GUID list', () => {
  assert.equal(parsePlexDetails(plexPayload())!.tmdb_id, '603');
});

test('no TMDB GUID gives no id rather than throwing', () => {
  const d = parsePlexDetails(plexPayload({ Guid: [{ id: 'imdb://tt0001' }] }))!;
  assert.equal(d.tmdb_id, null);
});

test('a payload with no metadata yields nothing rather than throwing', () => {
  assert.equal(parsePlexDetails({ MediaContainer: {} }), null);
  assert.equal(parsePlexDetails(null), null);
});

test('a long cast is capped so the panel stays readable', () => {
  const Role = Array.from({ length: 30 }, (_, i) => ({ tag: `Actor ${i}`, role: `Part ${i}` }));
  assert.equal(parsePlexDetails(plexPayload({ Role }))!.cast.length, MAX_CAST);
});

/* ------------------------------------------------------------------ tmdb */

const tmdbCredits = {
  credits: {
    cast: [
      { name: 'First Actor', character: 'The Lead' },
      { name: 'Second Actor', character: 'The Other One' },
    ],
    crew: [
      { name: 'A Director', job: 'Director' },
      { name: 'A Gaffer', job: 'Gaffer' },
    ],
  },
};

test('TMDB fills the cast in when Plex returned none', () => {
  const bare = parsePlexDetails(plexPayload({ Role: [] }))!;
  const merged = applyTmdbCredits(bare, tmdbCredits);
  assert.deepEqual(merged.cast, [
    { name: 'First Actor', role: 'The Lead' },
    { name: 'Second Actor', role: 'The Other One' },
  ]);
});

test('a cast Plex already gave is left alone', () => {
  const merged = applyTmdbCredits(parsePlexDetails(plexPayload())!, tmdbCredits);
  assert.deepEqual(merged.cast, [{ name: 'An Actor', role: 'The Drifter' }]);
});

test('only the director is taken out of the TMDB crew', () => {
  const bare = parsePlexDetails(plexPayload({ Director: [] }))!;
  assert.deepEqual(applyTmdbCredits(bare, tmdbCredits).directors, ['A Director']);
});

test('TMDB credits that are missing change nothing', () => {
  const d = parsePlexDetails(plexPayload())!;
  assert.deepEqual(applyTmdbCredits(d, {}).cast, d.cast);
});
