import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeEvent, type ShowShape } from '../src/episodes.ts';

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
