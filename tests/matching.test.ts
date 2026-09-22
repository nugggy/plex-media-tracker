import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMbid,
  mbidFromGuid,
  normaliseArtistName,
  normaliseTitle,
  normaliseTitleForOwnership,
  titleOverlap,
} from '../src/matching.ts';

test('normaliseTitle strips edition noise', () => {
  const cases: [string, string][] = [
    ['Golden Hour (Deluxe Edition)', 'golden hour'],
    ['Traveller [Remastered]', 'traveller'],
    ['Red – Taylor’s Version', 'red'],
    ['The Highwaymen', 'highwaymen'],
    ['Brothers and Sisters', 'brothers & sisters'],
    ['Café Bleu', 'cafe bleu'],
    ['A Star Is Born', 'star is born'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normaliseTitle(input), expected, `for ${input}`);
  }
});

test('the same record spelled two ways normalises to one value', () => {
  assert.equal(
    normaliseTitle('Chief (Expanded Edition)'),
    normaliseTitle('Chief [Deluxe]'),
  );
  assert.equal(
    normaliseTitle('Live Forever'),
    normaliseTitle('Live Forever (2024 Remaster)'),
  );
});

test('different records stay different', () => {
  assert.notEqual(normaliseTitle('Chief'), normaliseTitle('Chief II'));
  assert.notEqual(normaliseTitle('Blue'), normaliseTitle('Blue Smoke'));
});

test('normaliseArtistName handles the and articles', () => {
  assert.equal(normaliseArtistName('The Chicks'), 'chicks');
  assert.equal(normaliseArtistName('Brooks and Dunn'), normaliseArtistName('Brooks & Dunn'));
  assert.equal(normaliseArtistName('Sturgill Simpson'), 'sturgill simpson');
});

test('mbidFromGuid only accepts MusicBrainz guids', () => {
  assert.equal(
    mbidFromGuid('mbid://artist/07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64'),
    '07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64',
  );
  assert.equal(
    mbidFromGuid('com.plexapp.agents.musicbrainz://07EE6656-5A05-4F4A-A3E2-3D7AC0E2BA64'),
    '07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64',
  );
  assert.equal(mbidFromGuid('plex://artist/5d07bcbc403c6402904a5f6d'), null);
  assert.equal(mbidFromGuid(null), null);
});

test('isMbid rejects anything that is not a bare uuid', () => {
  assert.equal(isMbid('07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64'), true);
  assert.equal(isMbid('  07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64  '), true);
  assert.equal(isMbid('https://musicbrainz.org/artist/07ee6656-5a05-4f4a-a3e2-3d7ac0e2ba64'), false);
  assert.equal(isMbid('not-an-id'), false);
});

test('normaliseTitleForOwnership drops edition noise just like normaliseTitle', () => {
  assert.equal(normaliseTitleForOwnership('Chief (Deluxe Edition)'), 'chief');
  assert.equal(normaliseTitleForOwnership('Chief (Remastered)'), 'chief');
  assert.equal(normaliseTitleForOwnership('Chief'), 'chief');
});

test('normaliseTitleForOwnership keeps bracketed content that names a different record', () => {
  assert.equal(normaliseTitleForOwnership('Chief (Live)'), 'chief live');
  assert.equal(
    normaliseTitleForOwnership('Golden Hour (Original Soundtrack)'),
    'golden hour original soundtrack',
  );
});

test('normaliseTitleForOwnership does not fold a live album or a soundtrack onto the studio title', () => {
  assert.notEqual(normaliseTitleForOwnership('Chief (Live)'), normaliseTitleForOwnership('Chief'));
  assert.notEqual(
    normaliseTitleForOwnership('Golden Hour (Original Soundtrack)'),
    normaliseTitleForOwnership('Golden Hour'),
  );
});

test('normaliseTitleForOwnership still folds case, accents and punctuation', () => {
  assert.equal(
    normaliseTitleForOwnership('ONE THING AT A TIME!!'),
    normaliseTitleForOwnership('One Thing At A Time'),
  );
  assert.equal(normaliseTitleForOwnership('Café Bleu'), 'cafe bleu');
});

test('titleOverlap counts shared normalised titles', () => {
  const owned = new Set(['chief', 'blue smoke']);
  const candidate = new Set(['chief', 'something else']);
  assert.equal(titleOverlap(owned, candidate), 1);
  assert.equal(titleOverlap(owned, new Set()), 0);
});
