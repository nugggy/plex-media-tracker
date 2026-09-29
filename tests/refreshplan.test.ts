import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRefreshPlan, type RefreshPart } from '../src/refreshplan.ts';

/** Steps that record when they start and end, and can be held open. */
function harness() {
  const log: string[] = [];
  const gates = new Map<string, () => void>();
  const step = (name: RefreshPart) => async () => {
    log.push(`${name}:start`);
    await new Promise<void>((r) => gates.set(name, r));
    log.push(`${name}:end`);
  };
  const release = (name: RefreshPart) => {
    const r = gates.get(name);
    if (!r) throw new Error(`${name} has not started`);
    gates.delete(name);
    r();
  };
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    log,
    release,
    tick,
    steps: {
      holdings: step('holdings'),
      watchlist: step('watchlist'),
      schedules: step('schedules'),
      filmdates: step('filmdates'),
    },
  };
}

test('the home server and plex.tv are read at the same time', async () => {
  const h = harness();
  const run = runRefreshPlan(h.steps, new Set<RefreshPart>(['holdings', 'watchlist']));
  await h.tick();
  assert.deepEqual(h.log, ['holdings:start', 'watchlist:start']);
  h.release('watchlist');
  h.release('holdings');
  await run;
});

test('schedules and film dates wait for the watchlist, then run together', async () => {
  const h = harness();
  const run = runRefreshPlan(
    h.steps,
    new Set<RefreshPart>(['watchlist', 'schedules', 'filmdates']),
  );
  await h.tick();
  assert.deepEqual(h.log, ['watchlist:start']);
  h.release('watchlist');
  await h.tick();
  assert.deepEqual(h.log, ['watchlist:start', 'watchlist:end', 'schedules:start', 'filmdates:start']);
  h.release('filmdates');
  h.release('schedules');
  await run;
});

test('a slow server read does not hold up the plex.tv side', async () => {
  const h = harness();
  const run = runRefreshPlan(h.steps, new Set<RefreshPart>(['holdings', 'watchlist', 'schedules']));
  await h.tick();
  h.release('watchlist');
  await h.tick();
  assert.ok(h.log.includes('schedules:start'));
  assert.ok(!h.log.includes('holdings:end'));
  h.release('schedules');
  h.release('holdings');
  await run;
});

test('parts not asked for never run', async () => {
  const h = harness();
  const run = runRefreshPlan(h.steps, new Set<RefreshPart>(['schedules']));
  await h.tick();
  assert.deepEqual(h.log, ['schedules:start']);
  h.release('schedules');
  await run;
});

test('one part failing does not stop the others, and the plan itself resolves', async () => {
  const log: string[] = [];
  await runRefreshPlan(
    {
      holdings: async () => {
        throw new Error('server away');
      },
      watchlist: async () => {
        log.push('watchlist');
      },
      schedules: async () => {
        log.push('schedules');
      },
      filmdates: async () => {
        log.push('filmdates');
      },
    },
    new Set<RefreshPart>(['holdings', 'watchlist', 'schedules', 'filmdates']),
  );
  assert.deepEqual(log.sort(), ['filmdates', 'schedules', 'watchlist']);
});
