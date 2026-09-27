import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveDatabase, loadDatabase, toBase64, fromBase64, type FileApi } from '../mobile/storage.ts';

function memFs(crashOn?: 'remove' | 'rename'): FileApi & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async read(n) {
      return files.get(n) ?? null;
    },
    async write(n, b) {
      files.set(n, b);
    },
    async remove(n) {
      if (crashOn === 'remove') throw new Error('killed');
      files.delete(n);
    },
    async rename(a, b) {
      if (crashOn === 'rename') throw new Error('killed');
      files.set(b, files.get(a)!);
      files.delete(a);
    },
  };
}
const ok = () => true;
const bytes = (...n: number[]) => new Uint8Array(n);

test('first launch has nothing to load', async () => {
  assert.equal(await loadDatabase(memFs(), ok), null);
});

test('a save loads back identically', async () => {
  const fs = memFs();
  await saveDatabase(fs, bytes(1, 2, 3));
  assert.deepEqual(await loadDatabase(fs, ok), bytes(1, 2, 3));
});

test('killed after the old copy was removed: the new copy still loads', async () => {
  const dying = memFs('rename');
  dying.files.set('tracker.db', bytes(1));
  await saveDatabase(dying, bytes(2)).catch(() => {});
  assert.equal(dying.files.has('tracker.db'), false);
  assert.deepEqual(await loadDatabase(dying, ok), bytes(2));
});

test('killed before the old copy was removed: the old copy still loads', async () => {
  const dying = memFs('remove');
  dying.files.set('tracker.db', bytes(1));
  await saveDatabase(dying, bytes(2)).catch(() => {});
  assert.deepEqual(await loadDatabase(dying, ok), bytes(1));
});

test('a half-written new copy is ignored in favour of the last good one', async () => {
  const fs = memFs();
  fs.files.set('tracker.db', bytes(1));
  fs.files.set('tracker.db.tmp', bytes(9));
  const valid = (b: Uint8Array) => b[0] !== 9;
  assert.deepEqual(await loadDatabase(fs, valid), bytes(1));
});

test('base64 round trip on a database-sized array', () => {
  const big = new Uint8Array(3_000_000).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(big)), big);
});
