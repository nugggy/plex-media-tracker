import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainReason } from '../src/plainerror.ts';
import { PlexError, PlexUnreachable } from '../src/plex.ts';

test('an unreachable server is explained without the address and port detail', () => {
  const reason = plainReason(new PlexUnreachable('Could not reach Plex at http://10.0.0.2:32400. ...'));
  assert.equal(reason, 'Your Plex server did not answer. Check that it is switched on and connected.');
});

test('a rejected token points at Settings', () => {
  assert.match(plainReason(new PlexError('Plex rejected the token.', 401)), /token in Settings/);
});

test('a lost connection reads as an internet problem', () => {
  assert.match(plainReason(new TypeError('fetch failed')), /internet connection/);
});

test('anything unrecognised still gives one sentence with the cause', () => {
  assert.equal(plainReason(new Error('disk full.')), 'Something went wrong: disk full.');
});
