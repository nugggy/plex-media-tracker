/**
 * The NAS server, started for real, turns away every call without a session
 * apart from the handful needed to sign in. Every route in the API table is
 * tried, so a route added later cannot slip past the gate unnoticed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-gate-api-'));
const { ROUTES } = await import('../src/api.ts');

const PORT = 17000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, ['src/server.ts'], {
  cwd: new URL('../', import.meta.url),
  env: {
    ...process.env,
    NODE_TEST_CONTEXT: '',
    PLEX_TRACKER_HOST: '127.0.0.2',
    PLEX_TRACKER_AUTH: 'plex',
    PLEX_TRACKER_PORT: String(PORT),
    PLEX_TRACKER_DATA_DIR: mkdtempSync(join(tmpdir(), 'pmt-gate-')),
  },
  stdio: 'ignore',
});
after(() => child.kill());

const server = `http://127.0.0.2:${PORT}`;
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${server}/api/health`)).ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function call(method: string, path: string): Promise<number> {
  const r = await fetch(`${server}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
  await r.arrayBuffer();
  return r.status;
}

test('every API route and the picture proxy need a session', async () => {
  await waitForServer();
  const keys = [
    ...Object.keys(ROUTES),
    'GET /thumb',
    'GET /api/auth/sessions',
    'POST /api/auth/sessions/end',
    'POST /api/auth/signout-all',
    'GET /api/no-such-thing',
    'HEAD /api/state',
  ];
  for (const key of keys) {
    const [method, path] = key.split(' ') as [string, string];
    assert.equal(await call(method, path), 401, key);
  }
});

test('only the sign-in paths answer without a session', async () => {
  await waitForServer();
  assert.equal(await call('GET', '/api/health'), 200);
  assert.equal(await call('GET', '/api/auth/status'), 200);
  assert.equal(await call('POST', '/api/auth/check'), 200);
  assert.equal(await call('POST', '/api/auth/signout'), 200);
  assert.equal(await call('GET', '/api/auth/prove'), 404);
  // The page itself is public; it holds no data.
  assert.equal(await call('GET', '/'), 200);
});
