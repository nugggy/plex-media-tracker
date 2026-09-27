import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver } from '../mobile/persist.ts';

const settle = () => new Promise((r) => setImmediate(r));

test('saves once things have been quiet for five seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  s.markDirty();
  mock.timers.tick(4999);
  await settle();
  assert.equal(saves, 0);
  mock.timers.tick(1);
  await settle();
  assert.equal(saves, 1);
  mock.timers.reset();
});

test('keeps saving at least every 30 seconds while writes never stop', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  for (let i = 0; i < 70; i++) {
    s.markDirty();
    mock.timers.tick(1000);
    await settle();
  }
  assert.ok(saves >= 2, `saved ${saves} times in 70 s of constant writes`);
  mock.timers.reset();
});

test('never saves in the middle of a transaction', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let saves = 0;
  let open = true;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => open });
  s.markDirty();
  mock.timers.tick(10_000);
  await settle();
  assert.equal(saves, 0);
  open = false;
  mock.timers.tick(250);
  await settle();
  assert.equal(saves, 1);
  mock.timers.reset();
});

test('flush saves straight away when there is something to save, and not otherwise', async () => {
  let saves = 0;
  const s = createSaver({ save: async () => void (saves += 1), inTransaction: () => false });
  await s.flush();
  assert.equal(saves, 0);
  s.markDirty();
  await s.flush();
  assert.equal(saves, 1);
});
