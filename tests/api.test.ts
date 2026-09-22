import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedThumbHost, resolveThumbRedirect } from '../src/api.ts';
import { isSearchThumbHost } from '../src/search.ts';

test('Apple artwork is allowed', () => {
  assert.equal(allowedThumbHost('https://is1-ssl.mzstatic.com/image/a.png'), true);
  assert.equal(allowedThumbHost('https://is5-ssl.mzstatic.com/image/a.png'), true);
});

test('TMDB posters are allowed', () => {
  assert.equal(allowedThumbHost('https://image.tmdb.org/t/p/w342/a.jpg'), true);
});

/**
 * An artist photo starts at Special:FilePath on Commons and is redirected
 * twice before the image itself arrives, so every host on that path has to be
 * allowed or the picture dies on a later hop. Checked against the real
 * redirect chain, which ends at thumb.wikimedia.org for a sized image and at
 * upload.wikimedia.org for a full one.
 */
test('Wikimedia artist photos are allowed, at every hop', () => {
  assert.equal(
    allowedThumbHost('https://commons.wikimedia.org/wiki/Special:FilePath/a.jpg?width=300'),
    true,
  );
  assert.equal(
    allowedThumbHost('https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e1/a.jpg/300px-a.jpg'),
    true,
  );
  assert.equal(allowedThumbHost('https://upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg'), true);
});

test('the rest of Wikimedia is not allowed, only the file hosts', () => {
  assert.equal(allowedThumbHost('https://en.wikipedia.org/wiki/Main_Page'), false);
  assert.equal(allowedThumbHost('https://www.wikidata.org/wiki/Q42'), false);
});

test('anything else is refused, because an open proxy is a way into the network', () => {
  assert.equal(allowedThumbHost('http://127.0.0.1:32400/library/metadata/1'), false);
  assert.equal(allowedThumbHost('https://example.com/a.png'), false);
  assert.equal(allowedThumbHost('file:///c:/windows/win.ini'), false);
});

test('a host that merely ends with an allowed name is refused', () => {
  assert.equal(allowedThumbHost('https://image.tmdb.org.evil.test/a.jpg'), false);
});

test('nonsense is refused rather than throwing', () => {
  assert.equal(allowedThumbHost('not a url'), false);
  assert.equal(allowedThumbHost(''), false);
});

/*
 * Everything below is a bypass attempt against the allowlist, not just a
 * refusal case. Each one would slip through a check that merely does a
 * substring or "startsWith" test instead of parsing the URL properly.
 */

test('credentials placed before an allowed name do not make the real host allowed', () => {
  // The userinfo before "@" is "image.tmdb.org", but the actual host is evil.test.
  assert.equal(allowedThumbHost('https://image.tmdb.org@evil.test/a.jpg'), false);
});

test('a non-default port on an otherwise allowed host is refused', () => {
  // Chart artwork is always plain https on the default port. A port opens
  // a way to probe other services running on the same allowed hostname's
  // machine, for no legitimate benefit, so it is refused outright.
  assert.equal(allowedThumbHost('https://image.tmdb.org:8443/a.jpg'), false);
});

test('an uppercase or mixed-case host is still recognised', () => {
  // Hostnames are case-insensitive, and a bypass attempt might rely on a
  // check that only matches the lowercase form. The allowed host must
  // still be allowed, not refused, when cased differently.
  assert.equal(allowedThumbHost('https://IMAGE.TMDB.ORG/a.jpg'), true);
  assert.equal(allowedThumbHost('https://Image.Tmdb.Org/a.jpg'), true);
});

test('a trailing dot on the hostname is refused', () => {
  // "image.tmdb.org." is the same DNS name as "image.tmdb.org" to a
  // resolver, but it is a different string, and a check that only ever
  // saw the undotted form in testing could be fooled by this. Refusing it
  // is the stricter, safer choice.
  assert.equal(allowedThumbHost('https://image.tmdb.org./a.jpg'), false);
});

test('a non-https scheme on an otherwise allowed host is refused', () => {
  assert.equal(allowedThumbHost('http://image.tmdb.org/a.jpg'), false);
  assert.equal(allowedThumbHost('ftp://image.tmdb.org/a.jpg'), false);
});

test('a host that merely starts with an allowed name is refused', () => {
  // This is the leading-anchor counterpart to the "ends with" case above.
  // Dropping the "^" from the regex would let both of these through, and
  // the "ends with" test alone would not have caught that.
  assert.equal(allowedThumbHost('https://notimage.tmdb.org/a.jpg'), false);
  assert.equal(allowedThumbHost('https://evil-is1-ssl.mzstatic.com/a.png'), false);
});

/*
 * resolveThumbRedirect is the pure part of the redirect handling in
 * proxyThumb: given a Location header and the URL that sent it, work out
 * where the next hop goes and whether it is still allowed. The fetch loop
 * around it needs a real network call to exercise, so it is checked by hand
 * instead (see the fix report); this covers the part that decides safety.
 */

test('a redirect to another allowed host is followed', () => {
  assert.equal(
    resolveThumbRedirect('https://image.tmdb.org/t/p/w500/b.jpg', 'https://image.tmdb.org/t/p/w342/a.jpg'),
    'https://image.tmdb.org/t/p/w500/b.jpg',
  );
});

test('a relative redirect resolves against the URL that sent it', () => {
  // CDNs commonly redirect with a path-only Location, not a full URL.
  assert.equal(
    resolveThumbRedirect('/t/p/w500/b.jpg', 'https://image.tmdb.org/t/p/w342/a.jpg'),
    'https://image.tmdb.org/t/p/w500/b.jpg',
  );
});

test('a redirect off the allowlist is refused, however it is shaped', () => {
  assert.equal(
    resolveThumbRedirect('https://127.0.0.1:32400/library/metadata/1', 'https://image.tmdb.org/a.jpg'),
    null,
  );
  assert.equal(
    resolveThumbRedirect('https://image.tmdb.org.evil.test/a.jpg', 'https://image.tmdb.org/a.jpg'),
    null,
  );
});

test('a protocol-relative redirect that changes host is refused', () => {
  // "//host/path" takes its scheme from the base but its host from itself,
  // which is a common way a redirect quietly changes where it points.
  assert.equal(resolveThumbRedirect('//evil.test/a.jpg', 'https://image.tmdb.org/a.jpg'), null);
});

test('a redirect with an unparseable Location is refused rather than throwing', () => {
  assert.equal(resolveThumbRedirect('http://[::1', 'https://image.tmdb.org/a.jpg'), null);
});

/*
 * The chart-artwork tests above only ever exercise resolveThumbRedirect with
 * its default predicate. The search-thumb branch passes isSearchThumbHost
 * explicitly instead, and nothing above would notice if that argument were
 * silently dropped at the call site, since it defaults back to a predicate
 * that also happens to refuse most of the same hosts.
 */

test('resolveThumbRedirect refuses a host the search-thumb predicate does not allow', () => {
  assert.equal(
    resolveThumbRedirect('https://evil.test/a', 'https://metadata.provider.plex.tv/a', isSearchThumbHost),
    null,
  );
});

test('resolveThumbRedirect actually uses the predicate it is given, not the chart default', () => {
  // metadata.provider.plex.tv is allowed under isSearchThumbHost but is not
  // a chart-artwork host, so the two predicates disagree on it. If the
  // third argument were ever dropped and the default used instead, this
  // would come back null rather than the URL below, so it is this
  // disagreement, not the refusal case above, that actually proves the
  // predicate passed in is the one being used.
  assert.equal(
    resolveThumbRedirect(
      'https://metadata.provider.plex.tv/b',
      'https://metadata.provider.plex.tv/a',
      isSearchThumbHost,
    ),
    'https://metadata.provider.plex.tv/b',
  );
});
