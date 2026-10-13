import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../src/version.ts';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string };
const gradle = readFileSync(new URL('android/app/build.gradle', root), 'utf8');

function gradleField(name: string): string {
  const m = gradle.match(new RegExp(`^\\s*${name}\\s+"?([^"\\s]+)"?\\s*$`, 'm'));
  assert.ok(m, `${name} not found in android/app/build.gradle`);
  return m[1];
}

test('the app reports the same version as package.json', () => {
  assert.equal(APP_VERSION, pkg.version);
});

test('the Android build has the same version name as package.json', () => {
  assert.equal(gradleField('versionName'), pkg.version);
});

test('the Android version code is the version as MMmmpp, so every release counts up', () => {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  assert.ok(minor < 100 && patch < 100, 'minor and patch must stay under 100 to fit MMmmpp');
  assert.equal(Number(gradleField('versionCode')), major * 10000 + minor * 100 + patch);
});
