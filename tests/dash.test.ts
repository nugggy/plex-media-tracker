import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessions,
  parseHistory,
  parseRecentlyAdded,
  summariseHistory,
  isPlexArtPath,
} from '../src/dash.ts';

test('a transcoding episode reads show first, with its decision and progress', () => {
  const [s] = parseSessions({
    MediaContainer: {
      Metadata: [
        {
          type: 'episode',
          title: 'Pilot',
          grandparentTitle: 'Bluey',
          parentIndex: 1,
          index: 2,
          duration: 1000,
          viewOffset: 250,
          grandparentThumb: '/library/metadata/9/thumb/1',
          User: { title: 'sam' },
          Player: { title: 'Lounge TV', platform: 'Android', state: 'paused', local: true },
          Session: { id: 'abc', bandwidth: 8000 },
          TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' },
          Media: [{ videoResolution: '1080' }],
        },
      ],
    },
  });
  assert.equal(s.title, 'Bluey');
  assert.equal(s.subtitle, 'S01E02 · Pilot');
  assert.equal(s.decision, 'Transcode');
  assert.equal(s.quality, '1080p');
  assert.equal(s.progress, 0.25);
  assert.equal(s.state, 'paused');
  assert.equal(s.session_id, 'abc');
  assert.equal(s.thumb, '/library/metadata/9/thumb/1');
});

test('no transcode session is direct play, and copy only is direct stream', () => {
  const [a, b] = parseSessions({
    MediaContainer: {
      Metadata: [
        { type: 'movie', title: 'A' },
        { type: 'movie', title: 'B', TranscodeSession: { videoDecision: 'copy', audioDecision: 'copy' } },
      ],
    },
  });
  assert.equal(a.decision, 'Direct play');
  assert.equal(b.decision, 'Direct stream');
});

test('an empty server has no sessions', () => {
  assert.deepEqual(parseSessions({ MediaContainer: {} }), []);
});

test('history groups episodes under their show and ranks by plays', () => {
  const accounts = new Map([
    [1, 'Owner'],
    [2, 'Kid'],
  ]);
  const devices = new Map([[5, 'Roku']]);
  const plays = parseHistory(
    [
      { type: 'episode', title: 'E1', grandparentTitle: 'Bluey', accountID: 2, deviceID: 5, viewedAt: 30 },
      { type: 'episode', title: 'E2', grandparentTitle: 'Bluey', accountID: 2, deviceID: 5, viewedAt: 20 },
      { type: 'movie', title: 'Up', accountID: 1, deviceID: 9, viewedAt: 10 },
    ],
    accounts,
    devices,
  );
  const h = summariseHistory(plays, 30);
  assert.equal(h.plays, 3);
  assert.equal(h.titles, 2);
  assert.equal(h.users, 2);
  assert.deepEqual(h.top_titles[0], { label: 'Bluey', plays: 2 });
  assert.deepEqual(h.top_users[0], { label: 'Kid', plays: 2 });
  assert.equal(h.top_platforms.find((p) => p.label === 'Unknown device')?.plays, 1);
  assert.deepEqual(
    h.by_kind.map((k) => k.label),
    ['Episodes', 'Films'],
  );
  assert.equal(h.recent[0].subtitle, 'E1');
});

test('a recently added season is named after its show', () => {
  const [a] = parseRecentlyAdded({
    MediaContainer: {
      Metadata: [{ type: 'season', title: 'Season 3', parentTitle: 'Bluey', ratingKey: '7', addedAt: 5 }],
    },
  });
  assert.equal(a.title, 'Bluey');
  assert.equal(a.subtitle, 'Season 3');
  assert.equal(a.rating_key, '7');
});

test('only Plex artwork paths pass the thumbnail check', () => {
  assert.equal(isPlexArtPath('/library/metadata/123/thumb/1699999999'), true);
  assert.equal(isPlexArtPath('/library/metadata/123/art/1'), true);
  assert.equal(isPlexArtPath('/status/sessions/terminate'), false);
  assert.equal(isPlexArtPath('/library/metadata/123/thumb/1?x=1'), false);
  assert.equal(isPlexArtPath('/library/metadata/../../accounts'), false);
  assert.equal(isPlexArtPath('http://evil/library/metadata/1/thumb/1'), false);
});
