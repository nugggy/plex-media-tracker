import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nasHost, toSharePath, sidecarPath } from '../src/lyricpaths.ts';

const SONG = '/share/CACHEDEV1_DATA/Nuggy NAS Shared Folder/PLEX Library/Music/Kryptonite.mp3';

test('a QNAP path Plex reports becomes the network path this PC uses', () => {
  assert.equal(
    toSharePath(SONG, 'http://192.168.0.162:32400/'),
    String.raw`\\192.168.0.162\Nuggy NAS Shared Folder\PLEX Library\Music\Kryptonite.mp3`,
  );
});

test('a plex.direct address still gives the NAS its home address', () => {
  assert.equal(nasHost('https://192-168-0-162.abc123.plex.direct:32400'), '192.168.0.162');
});

test('a server reached from outside the home has no network path', () => {
  assert.equal(toSharePath(SONG, 'https://203.0.113.5:32400'), null);
  assert.equal(toSharePath(SONG, 'https://relay-1.plex.tv'), null);
});

test('a path that is not on a QNAP share is left alone', () => {
  assert.equal(toSharePath('/music/song.mp3', 'http://192.168.0.162:32400'), null);
});

test('the lyric file takes the song name exactly, with only the extension changed', () => {
  assert.equal(
    sidecarPath(String.raw`\\nas\Music\01. Kryptonite.flac`, 'lrc'),
    String.raw`\\nas\Music\01. Kryptonite.lrc`,
  );
  assert.equal(sidecarPath(String.raw`\\nas\Mr. Big\Track`, 'txt'), String.raw`\\nas\Mr. Big\Track.txt`);
});
