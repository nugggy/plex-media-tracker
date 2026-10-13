import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database, a stubbed Plex and a pretend disk, so nothing here
// reaches the real server or the NAS.
process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-lyricexport-'));
const store = await import('../src/db.ts');
const { saveLyric, lyricsProgress } = await import('../src/lyrics.ts');
const { exportLyrics } = await import('../src/lyricexport.ts');
type LyricDisk = import('../src/lyricexport.ts').LyricDisk;

const SERVER = 'http://192.168.0.162:32400';
store.setSetting('plex_connection', 'manual');
store.setSetting('plex_url', SERVER);
store.setSetting('plex_token', 'tok');

const fileFor = (key: string) => `/share/CACHEDEV1_DATA/Music/Artist/Album/${key}.flac`;
const shareFor = (key: string, ext: string) => `\\\\192.168.0.162\\Music\\Artist\\Album\\${key}.${ext}`;

const refreshed: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (init?.method === 'PUT') {
    refreshed.push(url.pathname);
    return new Response('', { status: 200 });
  }
  // /library/metadata/1,2,3: where each track's file lives.
  const keys = url.pathname.replace('/library/metadata/', '').split(',');
  return new Response(
    JSON.stringify({
      MediaContainer: {
        Metadata: keys.map((k) => ({
          ratingKey: k,
          parentRatingKey: 'album-1',
          Media: [{ Part: [{ file: fileFor(k) }] }],
        })),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}) as typeof fetch;

const track = (key: string) => ({
  rating_key: key,
  title: `Song ${key}`,
  artist: 'Artist',
  album: 'Album',
  duration_ms: 180_000,
  covered: false,
});
for (const key of ['1', '2', '3']) {
  saveLyric(track(key), { synced: `[00:01.00] words ${key}`, plain: null, instrumental: false }, 'lrclib');
}

function disk(over: Partial<LyricDisk> = {}): LyricDisk & { written: string[] } {
  const written: string[] = [];
  return {
    canWrite: true,
    fileExists: async () => false,
    async writeNewFile(path) {
      written.push(path);
    },
    written,
    ...over,
  };
}

beforeEach(() => {
  refreshed.length = 0;
});

test('each lyric is written beside its song, and Plex is asked to re-read the album', async () => {
  const d = disk();
  const result = await exportLyrics(['1', '2'], d);
  assert.equal(result.saved, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(d.written, [shareFor('1', 'lrc'), shareFor('2', 'lrc')]);
  assert.deepEqual(refreshed, ['/library/metadata/album-1/refresh']);
  assert.equal(lyricsProgress().running, false);
});

test('a file that appears between the check and the write counts as already there', async () => {
  const d = disk({
    async writeNewFile(path) {
      if (path.includes('\\2.')) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      d.written.push(path);
    },
  });
  const result = await exportLyrics(['1', '2', '3'], d);
  assert.equal(result.saved, 2);
  assert.equal(result.alreadyThere, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.ok, true);
});

test('the first real write failure stops the run, since the rest would fail the same way', async () => {
  let attempts = 0;
  const d = disk({
    async writeNewFile() {
      attempts += 1;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  });
  const result = await exportLyrics(['1', '2', '3'], d);
  assert.equal(attempts, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.saved, 0);
  assert.equal(result.ok, false);
  assert.match(result.message, /not allowed to write/);
  assert.deepEqual(refreshed, []);
});

test('an existing lyric file is never replaced', async () => {
  const d = disk({ fileExists: async (path) => path.endsWith('.txt') });
  const result = await exportLyrics(['1'], d);
  assert.equal(result.alreadyThere, 1);
  assert.deepEqual(d.written, []);
});

test('a build that cannot write files says so instead of trying', async () => {
  const result = await exportLyrics(['1'], disk({ canWrite: false }));
  assert.equal(result.ok, false);
  assert.match(result.message, /desktop app only/);
});
