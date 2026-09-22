import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCandidates,
  scoreCandidate,
  queryFor,
  applyLookupOutcome,
  type Candidate,
} from '../src/youtube.ts';

const c = (title: string, channel = ''): Candidate => ({ id: 'x'.repeat(11), title, channel });

const TRACK = { kind: 'single', title: 'Coming Down (Again)', artist: 'Uncle Lucius' };

/* ------------------------------------------------------------- the report */

test('the exact track is accepted even when the channel is not the artist', () => {
  // The real case: YouTube files this art track under "Release - Topic".
  assert.ok(scoreCandidate(c('Coming Down (Again)', 'Release - Topic'), TRACK) > 0);
});

test('a more famous song by the right artist is rejected', () => {
  // This is what the app wrongly showed before.
  assert.equal(scoreCandidate(c('Uncle Lucius - Keep The Wolves Away', 'unclelucius'), TRACK), 0);
});

test('the same title by a different artist is rejected', () => {
  assert.equal(scoreCandidate(c('Coming Down (Live)', 'Tyler Childers'), TRACK), 0);
  assert.equal(scoreCandidate(c('Coming Down', 'Some Other Band'), TRACK), 0);
});

/* ----------------------------------------------------------------- ranking */

test('naming the artist outranks an exact title alone', () => {
  const named = scoreCandidate(c('Uncle Lucius - Coming Down (Again)', 'unclelucius'), TRACK);
  const bare = scoreCandidate(c('Coming Down (Again)', 'Release - Topic'), TRACK);
  assert.ok(named > bare, `${named} should beat ${bare}`);
});

test('a live or cover version loses to the studio recording', () => {
  const studio = scoreCandidate(c('Uncle Lucius - Coming Down (Again)', 'unclelucius'), TRACK);
  const live = scoreCandidate(
    c('Uncle Lucius - Coming Down (Again) (Live at the Ryman)', 'unclelucius'),
    TRACK,
  );
  const cover = scoreCandidate(c('Coming Down (Again) - cover by Dave', 'Dave'), TRACK);
  assert.ok(studio > live, 'studio should beat live');
  assert.ok(studio > cover, 'studio should beat a cover');
});

test('punctuation and case do not matter', () => {
  assert.ok(scoreCandidate(c('UNCLE LUCIUS — Coming Down [Again]', 'x'), TRACK) > 0);
});

/* ---------------------------------------------------------------- trailers */

test('a trailer is preferred over any other upload of the same film', () => {
  const want = { kind: 'movie', title: 'Wuthering Heights', artist: '' };
  const trailer = scoreCandidate(c('Wuthering Heights | Official Trailer', 'Warner Bros.'), want);
  const other = scoreCandidate(c('Wuthering Heights full audiobook', 'Books'), want);
  assert.ok(trailer > 0);
  assert.ok(trailer > other);
});

test('a film needs no artist, a track does', () => {
  assert.ok(scoreCandidate(c('MobLand | Official Trailer', 'Paramount'), {
    kind: 'show',
    title: 'MobLand',
    artist: '',
  }) > 0);
  assert.equal(scoreCandidate(c('Some Song', 'Someone'), { kind: 'single', title: 'Some Song', artist: 'Real Artist' }) > 0, true);
});

/* ----------------------------------------------------------------- queries */

test('bracketed parts of a track name are kept in the query', () => {
  // Stripping "(Again)" is what sent the original search to the wrong song.
  assert.equal(queryFor(TRACK), 'Uncle Lucius Coming Down (Again)');
});

test('films and shows ask for a trailer', () => {
  assert.equal(queryFor({ kind: 'movie', title: 'Verity', artist: '' }), 'Verity official trailer');
  assert.equal(queryFor({ kind: 'show', title: 'MobLand', artist: '' }), 'MobLand trailer');
});

/* -------------------------------------------------------------- extraction */

test('candidates are pulled out of a search page with their titles', () => {
  const data = {
    contents: {
      sections: [
        {
          items: [
            {
              videoRenderer: {
                videoId: 'g3qz4j9rs58',
                title: { runs: [{ text: 'Coming Down (Again)' }] },
                ownerText: { runs: [{ text: 'Release - Topic' }] },
              },
            },
            {
              videoRenderer: {
                videoId: 'pYdvxBxHX2U',
                title: { runs: [{ text: 'Uncle Lucius - Keep The Wolves Away' }] },
                ownerText: { runs: [{ text: 'unclelucius' }] },
              },
            },
          ],
        },
      ],
    },
  };
  const html = `<html><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`;
  const found = extractCandidates(html);
  assert.equal(found.length, 2);
  assert.equal(found[0]!.id, 'g3qz4j9rs58');
  assert.equal(found[0]!.title, 'Coming Down (Again)');
  assert.equal(found[0]!.channel, 'Release - Topic');
});

test('extraction copes with braces and quotes inside titles', () => {
  const data = {
    x: {
      videoRenderer: {
        videoId: 'abcdefghijk',
        title: { runs: [{ text: 'A song {with} "quotes" and \\ a slash' }] },
        ownerText: { simpleText: 'Band' },
      },
    },
  };
  const html = `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
  const found = extractCandidates(html);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.title, 'A song {with} "quotes" and \\ a slash');
});

test('a page with no data yields nothing rather than throwing', () => {
  assert.deepEqual(extractCandidates('<html>nothing here</html>'), []);
  assert.deepEqual(extractCandidates('var ytInitialData = {broken'), []);
});

/* --------------------------------------------------------- caching a miss */

test('a failed lookup is not cached, so a network blip cannot become a two-week miss', () => {
  const decided = applyLookupOutcome({ ok: false });
  assert.equal(decided.shouldCache, false);
  assert.equal(decided.video_id, null);
  assert.equal(decided.video_title, null);
});

test('YouTube genuinely having nothing is cached, unlike a failed attempt', () => {
  const decided = applyLookupOutcome({ ok: true, candidate: null });
  assert.equal(decided.shouldCache, true);
  assert.equal(decided.video_id, null);
});

test('a real match is cached with its id and title', () => {
  const decided = applyLookupOutcome({
    ok: true,
    candidate: c('Coming Down (Again)', 'Release - Topic'),
  });
  assert.equal(decided.shouldCache, true);
  assert.equal(decided.video_id, 'xxxxxxxxxxx');
  assert.equal(decided.video_title, 'Coming Down (Again)');
});
