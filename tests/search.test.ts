import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDiscoverMatch, resolveSearchThumb, isSearchThumbHost } from '../src/search.ts';

const want = { title: 'Wicked', year: 2026, kind: 'movie' as const };

test('an exact title and year is the strongest match', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2026, kind: 'movie' }, want) > 0);
});

test('a different title never matches, however close the year', () => {
  assert.equal(scoreDiscoverMatch({ title: 'Wicked Games', year: 2026, kind: 'movie' }, want), 0);
});

test('a year one out still matches, since sources disagree on release year', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2025, kind: 'movie' }, want) > 0);
});

test('the right title in the wrong decade does not match', () => {
  assert.equal(scoreDiscoverMatch({ title: 'Wicked', year: 1998, kind: 'movie' }, want), 0);
});

test('the same year outranks a year that is merely close', () => {
  const exact = scoreDiscoverMatch({ title: 'Wicked', year: 2026, kind: 'movie' }, want);
  const near = scoreDiscoverMatch({ title: 'Wicked', year: 2025, kind: 'movie' }, want);
  assert.ok(exact > near);
});

test('case and punctuation do not matter', () => {
  assert.ok(scoreDiscoverMatch({ title: 'WICKED!', year: 2026, kind: 'movie' }, want) > 0);
});

test('a missing year on either side still allows a title match', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: null, kind: 'movie' }, want) > 0);
  assert.ok(
    scoreDiscoverMatch(
      { title: 'Wicked', year: 2026, kind: 'movie' },
      { title: 'Wicked', year: null, kind: 'movie' },
    ) > 0,
  );
});

test('a year two out is refused, which is where the tolerance stops', () => {
  assert.equal(scoreDiscoverMatch({ title: 'Wicked', year: 2024, kind: 'movie' }, want), 0);
});

test('a year one out on the other side still matches', () => {
  assert.ok(scoreDiscoverMatch({ title: 'Wicked', year: 2027, kind: 'movie' }, want) > 0);
});

test('a show never matches a film of the same name and year', () => {
  assert.equal(
    scoreDiscoverMatch({ title: 'Wicked', year: 2026, kind: 'show' }, { ...want, kind: 'movie' }),
    0,
  );
});

test('a film never matches a show of the same name and year', () => {
  assert.equal(
    scoreDiscoverMatch({ title: 'Wicked', year: 2026, kind: 'movie' }, { ...want, kind: 'show' }),
    0,
  );
});

test('the kind is checked before the year, so a wrong kind loses even on an exact year', () => {
  const wrongKind = scoreDiscoverMatch(
    { title: 'Wicked', year: 2026, kind: 'show' },
    { ...want, kind: 'movie' },
  );
  const rightKindNearYear = scoreDiscoverMatch(
    { title: 'Wicked', year: 2025, kind: 'movie' },
    { ...want, kind: 'movie' },
  );
  assert.equal(wrongKind, 0);
  assert.ok(rightKindNearYear > 0);
});

/*
 * A Discover thumb comes back on the page's own query string, so a request
 * to /thumb can supply anything at all here, not only what Discover really
 * returned. resolveSearchThumb is what stops that becoming a way to send
 * the real Plex token to an arbitrary host.
 */

test('a Plex-relative path resolves onto the metadata host', () => {
  assert.equal(
    resolveSearchThumb('/library/metadata/12345/thumb/167234'),
    'https://metadata.provider.plex.tv/library/metadata/12345/thumb/167234',
  );
});

test('an absolute URL on a host other than plex.tv metadata is refused', () => {
  assert.equal(resolveSearchThumb('http://192.168.1.50/anything'), null);
  assert.equal(resolveSearchThumb('https://evil.test/a.jpg'), null);
});

test('an absolute URL on the plex.tv metadata host is accepted unchanged', () => {
  const url = 'https://metadata.provider.plex.tv/library/metadata/9/thumb/1';
  assert.equal(resolveSearchThumb(url), url);
});

test('a value beginning with two slashes is protocol-relative, not a path, and is refused', () => {
  // "//evil.test/a.jpg" starts with "/" like a legitimate path does, but a
  // browser (and new URL()) reads the doubled slash as "keep the current
  // scheme, take the host from what follows" - so treating it as a path
  // would smuggle a different host past the check entirely.
  assert.equal(resolveSearchThumb('//evil.test/a.jpg'), null);
});

test('nonsense is refused rather than throwing', () => {
  assert.equal(resolveSearchThumb('not a url'), null);
  assert.equal(resolveSearchThumb(''), null);
  assert.equal(isSearchThumbHost('not a url'), false);
});

test('a port on the metadata host is refused, since it is never a legitimate part of a Discover thumb', () => {
  assert.equal(isSearchThumbHost('https://metadata.provider.plex.tv:8443/a'), false);
});

test('a host that merely ends with the metadata host name is refused', () => {
  assert.equal(isSearchThumbHost('https://metadata.provider.plex.tv.evil.test/a'), false);
});
