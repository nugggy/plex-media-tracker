import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artistBlurb,
  wikidataId,
  wikidataImage,
  commonsImageUrl,
  type MbArtistDetail,
} from '../src/artistinfo.ts';

function artist(over: Partial<MbArtistDetail> = {}): MbArtistDetail {
  return { id: 'mbid', name: 'An Artist', ...over };
}

/* ----------------------------------------------------------------- blurb */

test('a group reads as a group, with its genre in front', () => {
  const blurb = artistBlurb(
    artist({
      type: 'Group',
      tags: [{ name: 'country', count: 9 }],
      area: { name: 'United States' },
    }),
  );
  assert.match(blurb, /^Country group from United States/);
});

test('a person reads as an artist rather than a person', () => {
  const blurb = artistBlurb(artist({ type: 'Person', area: { name: 'Australia' } }));
  assert.match(blurb, /^Artist from Australia/);
});

test('the town is named ahead of the country when MusicBrainz knows both', () => {
  const blurb = artistBlurb(
    artist({
      type: 'Group',
      'begin-area': { name: 'Nashville' },
      area: { name: 'United States' },
    }),
  );
  assert.match(blurb, /from Nashville, United States/);
});

test('a town that repeats the area is not said twice', () => {
  const blurb = artistBlurb(
    artist({ type: 'Group', 'begin-area': { name: 'Australia' }, area: { name: 'Australia' } }),
  );
  assert.match(blurb, /from Australia\b/);
  assert.doesNotMatch(blurb, /Australia, Australia/);
});

test('a bare country code is not passed off as a place name', () => {
  const blurb = artistBlurb(artist({ type: 'Group', country: 'US' }));
  assert.doesNotMatch(blurb, /\bUS\b/);
});

test('a group is formed, where a person is born', () => {
  assert.match(
    artistBlurb(artist({ type: 'Group', 'life-span': { begin: '1998-03-01' } })),
    /formed 1998/,
  );
  assert.match(
    artistBlurb(artist({ type: 'Person', 'life-span': { begin: '1971-05-02' } })),
    /born 1971/,
  );
});

test('an act that has ended says so', () => {
  assert.match(
    artistBlurb(artist({ type: 'Group', 'life-span': { begin: '1998', end: '2012', ended: true } })),
    /formed 1998, disbanded 2012/,
  );
});

/**
 * A life span means one thing for a group and another for a person, so with no
 * type there is no way to word it that is not a guess. Saying nothing is better
 * than calling a birth a formation.
 */
test('a life span is left out entirely when the type is unknown', () => {
  const blurb = artistBlurb(artist({ 'life-span': { begin: '1998' }, area: { name: 'Canada' } }));
  assert.equal(blurb, 'Artist from Canada.');
});

test('the remaining tags follow as a second sentence', () => {
  const blurb = artistBlurb(
    artist({
      type: 'Group',
      tags: [
        { name: 'country', count: 9 },
        { name: 'americana', count: 4 },
        { name: 'southern rock', count: 2 },
      ],
    }),
  );
  assert.match(blurb, /Tagged americana, southern rock\./);
});

test('the lead genre is not repeated in the tag list', () => {
  const blurb = artistBlurb(
    artist({ type: 'Group', tags: [{ name: 'country', count: 9 }] }),
  );
  assert.match(blurb, /^Country group/);
  assert.doesNotMatch(blurb, /Tagged/);
});

test('tags are ordered by how many people agreed, not how they arrived', () => {
  const blurb = artistBlurb(
    artist({
      type: 'Group',
      tags: [
        { name: 'folk', count: 1 },
        { name: 'bluegrass', count: 12 },
        { name: 'country', count: 5 },
      ],
    }),
  );
  assert.match(blurb, /^Bluegrass group/);
  assert.match(blurb, /Tagged country, folk\./);
});

test('at most three tags, so the card stays readable', () => {
  const blurb = artistBlurb(
    artist({
      type: 'Group',
      tags: [
        { name: 'lead', count: 6 },
        { name: 'a', count: 5 },
        { name: 'b', count: 4 },
        { name: 'c', count: 3 },
        { name: 'd', count: 2 },
      ],
    }),
  );
  assert.match(blurb, /Tagged a, b, c\./);
  assert.doesNotMatch(blurb, /\bd\b/);
});

test('an artist MusicBrainz knows nothing about gets no invented blurb', () => {
  assert.equal(artistBlurb(artist()), '');
});

test('the blurb is one capitalised sentence, or two, and ends in a full stop', () => {
  const blurb = artistBlurb(artist({ type: 'Person', area: { name: 'Ireland' } }));
  assert.equal(blurb, 'Artist from Ireland.');
});

/* -------------------------------------------------------------- wikidata */

test('the Wikidata id is read off the relationship list', () => {
  const id = wikidataId(
    artist({
      relations: [
        { type: 'official homepage', url: { resource: 'https://example.test' } },
        { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q42' } },
      ],
    }),
  );
  assert.equal(id, 'Q42');
});

test('an artist with no Wikidata link has no id, rather than a broken one', () => {
  assert.equal(wikidataId(artist()), null);
  assert.equal(
    wikidataId(artist({ relations: [{ type: 'discogs', url: { resource: 'https://d.test' } }] })),
    null,
  );
});

test('something that is not a Q number is refused', () => {
  const id = wikidataId(
    artist({ relations: [{ type: 'wikidata', url: { resource: 'https://evil.test/Q42' } }] }),
  );
  assert.equal(id, null);
});

test('the P18 image claim becomes a Commons URL', () => {
  const url = wikidataImage(
    { entities: { Q42: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Kacey.jpg' } } }] } } } },
    'Q42',
  );
  assert.equal(url, 'https://commons.wikimedia.org/wiki/Special:FilePath/Kacey.jpg?width=300');
});

test('an entity with no picture gives nothing rather than a dead link', () => {
  assert.equal(wikidataImage({ entities: { Q42: { claims: {} } } }, 'Q42'), null);
  assert.equal(wikidataImage({ entities: {} }, 'Q42'), null);
  assert.equal(wikidataImage({}, 'Q42'), null);
});

/**
 * Commons file names carry spaces, apostrophes and accents. Special:FilePath
 * takes underscores for spaces, and everything else has to be escaped or the
 * proxy is handed a URL that will not parse.
 */
test('a file name with spaces and punctuation survives the trip', () => {
  assert.equal(
    commonsImageUrl("Kacey Musgraves' show.jpg"),
    'https://commons.wikimedia.org/wiki/Special:FilePath/Kacey_Musgraves\'_show.jpg?width=300',
  );
});

test('a file name cannot smuggle in a query string or another host', () => {
  assert.match(commonsImageUrl('a.jpg?evil=1'), /Special:FilePath\/a\.jpg%3Fevil%3D1\?width=300$/);
  assert.match(
    commonsImageUrl('//evil.test/a.jpg'),
    /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//,
  );
});

test('an empty file name is not turned into a URL', () => {
  assert.equal(commonsImageUrl(''), null);
});
