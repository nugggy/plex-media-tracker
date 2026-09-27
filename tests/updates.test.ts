import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pickUpdate } from '../mobile/updates.ts';

test('versions compare by number, not as text', () => {
  assert.ok(compareVersions('1.2.10', '1.2.9') > 0);
  assert.ok(compareVersions('1.3.0', '1.2.99') > 0);
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
  assert.ok(compareVersions('1.2', '1.2.1') < 0);
});

const release = (tag: string, assets: { name: string; browser_download_url: string }[], extra = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets,
  ...extra,
});
const apk = (v: string) => ({
  name: `plex-media-tracker-${v}.apk`,
  browser_download_url: `https://github.com/nugggy/plex-media-tracker/releases/download/v${v}/plex-media-tracker-${v}.apk`,
});

test('a newer release offers its APK', () => {
  assert.deepEqual(pickUpdate(release('v1.2.1', [apk('1.2.1')]), '1.2.0'), {
    version: '1.2.1',
    url: apk('1.2.1').browser_download_url,
  });
});

test('the same or an older release offers nothing', () => {
  assert.equal(pickUpdate(release('v1.2.0', [apk('1.2.0')]), '1.2.0'), null);
  assert.equal(pickUpdate(release('v1.1.9', [apk('1.1.9')]), '1.2.0'), null);
});

test('a release with no APK attached offers nothing', () => {
  assert.equal(pickUpdate(release('v1.3.0', [{ name: 'notes.txt', browser_download_url: 'x' }]), '1.2.0'), null);
});

test('drafts and pre-releases are never offered', () => {
  assert.equal(pickUpdate(release('v1.3.0', [apk('1.3.0')], { prerelease: true }), '1.2.0'), null);
  assert.equal(pickUpdate(release('v1.3.0', [apk('1.3.0')], { draft: true }), '1.2.0'), null);
});

test('an APK hosted anywhere but this repository is never offered', () => {
  const elsewhere = { name: 'plex-media-tracker-1.3.0.apk', browser_download_url: 'https://evil.example/app.apk' };
  assert.equal(pickUpdate(release('v1.3.0', [elsewhere]), '1.2.0'), null);
});

test('an unexpected reply from GitHub offers nothing rather than throwing', () => {
  assert.equal(pickUpdate({ message: 'Not Found' }, '1.2.0'), null);
  assert.equal(pickUpdate(null, '1.2.0'), null);
});
