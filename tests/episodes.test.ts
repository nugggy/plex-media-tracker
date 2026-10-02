import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coveredBySegments,
  episodeEvent,
  type SeasonEpisode,
  type ShowShape,
} from '../src/episodes.ts';

/** A show holding whole seasons, the shape a finished run has. */
function shape(seasons: Record<number, number>, ended = false): ShowShape {
  return {
    seasons: new Map(
      Object.entries(seasons).map(([season, count]) => [
        Number(season),
        { first: 1, last: count, count },
      ]),
    ),
    ended,
  };
}

test('the first episode of the first season is a series premiere', () => {
  assert.equal(episodeEvent(1, 1, shape({ 1: 10 })), 'series premiere');
});

test('the first episode of a later season is a season premiere', () => {
  assert.equal(episodeEvent(4, 1, shape({ 3: 10, 4: 10 })), 'season premiere');
});

test('the last episode of a listed season is a season finale', () => {
  assert.equal(episodeEvent(4, 10, shape({ 3: 10, 4: 10 })), 'season finale');
});

test('anything in between is just an episode', () => {
  assert.equal(episodeEvent(4, 5, shape({ 4: 10 })), 'episode');
});

test('the last episode of a finished series is a series finale', () => {
  const ended = shape({ 5: 8, 6: 6 }, true);
  assert.equal(episodeEvent(6, 6, ended), 'series finale');
  // The season before it ended a season, not the series.
  assert.equal(episodeEvent(5, 8, ended), 'season finale');
});

test('a continuing show never ends its series, only its seasons', () => {
  assert.equal(episodeEvent(6, 6, shape({ 5: 8, 6: 6 })), 'season finale');
});

/*
 * Plex lists a season as it is announced, so a season held with gaps in it, or
 * one whose opening episodes are missing, is a season we are not seeing whole.
 * Naming a finale there would badge whichever row happens to be last.
 */
test('a season held with gaps in it has no finale', () => {
  const gapped: ShowShape = {
    seasons: new Map([[2, { first: 3, last: 9, count: 7 }]]),
    ended: false,
  };
  assert.equal(episodeEvent(2, 9, gapped), 'episode');

  const holes: ShowShape = {
    seasons: new Map([[2, { first: 1, last: 10, count: 7 }]]),
    ended: false,
  };
  assert.equal(episodeEvent(2, 10, holes), 'episode');
});

test('an episode with no numbering is left alone', () => {
  assert.equal(episodeEvent(null, null, shape({ 1: 10 })), 'episode');
  assert.equal(episodeEvent(2, null, shape({ 2: 10 })), 'episode');
});

test('a show with nothing known about its seasons claims no finale', () => {
  assert.equal(episodeEvent(2, 8, undefined), 'episode');
  assert.equal(episodeEvent(2, 1, undefined), 'season premiere');
});

/*
 * Coven Academy as Plex's catalogue listed it: ten doubles, then the same
 * segments again as singles, one of them a bare placeholder. The server held
 * the ten doubles, which is the whole season.
 */
function ep(episode: number, title: string, held = false): SeasonEpisode {
  return { key: `e${episode}`, episode, title, localTitle: null, held };
}

const DOUBLES = [
  'A Hex Education / Blood, Sweat, and Fears / Mother of All Secrets',
  'Dead Ends / Power Trip',
  'Roses Are Red / Pick Your Poison',
  'The Scrying Game / Trial by Fire',
  'Time Warp / The Night It Happened',
  'Between Worlds / What She Saw',
  'Witchgiving / Cold Turkey',
  '1998 / Thicker Than Water',
  'Winter Solstice / The Covening',
  'Bloodlines / After the Ashes',
];
const SINGLES = [
  'Time Warp', 'Episode 12', 'What She Saw', 'Witchgiving', 'Cold Turkey', '1998',
  'Thicker Than Water', 'Winter Solstice', 'The Covening', 'Bloodlines', 'After the Ashes',
];

test('singles that repeat held doubles count as held, placeholder included', () => {
  const season = [
    ...DOUBLES.map((t, i) => ep(i + 1, t, true)),
    ...SINGLES.map((t, i) => ep(i + 11, t)),
  ];
  const covered = coveredBySegments(season);
  assert.equal(covered.size, SINGLES.length);
  assert.ok(covered.has('e12'));
});

test('the server title counts when Plex Discover has only a placeholder', () => {
  const season: SeasonEpisode[] = [
    { key: 'e1', episode: 1, title: 'Episode 1', localTitle: 'Witchgiving / Cold Turkey', held: true },
    ep(2, 'Cold Turkey'),
  ];
  assert.deepEqual([...coveredBySegments(season)], ['e2']);
});

test('a single not inside any held double stays missing, and so does a placeholder', () => {
  const season = [ep(1, 'Witchgiving / Cold Turkey', true), ep(2, 'Cold Turkey'), ep(3, 'Brand New'), ep(4, 'Episode 4')];
  assert.deepEqual([...coveredBySegments(season)], ['e2']);
});

test('holding half a season of doubles covers nothing more', () => {
  const season = DOUBLES.map((t, i) => ep(i + 1, t, i < 5));
  assert.equal(coveredBySegments(season).size, 0);
});

test('an ordinary show with single titles is left to its numbers', () => {
  const season = [ep(1, 'Pilot', true), ep(2, 'Pilot'), ep(3, 'Episode 3')];
  assert.equal(coveredBySegments(season).size, 0);
});
