import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFetchBridge, thumbLoader } from '../mobile/bridge.ts';

function fakeWin(real: typeof fetch) {
  return { fetch: real, location: { origin: 'https://localhost' } };
}

test('API calls go to the in-app router, not the network', async () => {
  let network = 0;
  const win = fakeWin((async () => {
    network += 1;
    return new Response('');
  }) as typeof fetch);
  installFetchBridge(win, async (method, url, body) => ({
    status: 201,
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ method, path: url.pathname, body })),
  }));
  const r = await win.fetch('/api/settings', { method: 'POST', body: '{"a":1}' });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { method: 'POST', path: '/api/settings', body: '{"a":1}' });
  assert.equal(network, 0);
});

test('thumbnail requests also stay inside the app', async () => {
  let routed = '';
  const win = fakeWin((async () => {
    throw new Error('should not reach the network');
  }) as typeof fetch);
  installFetchBridge(win, async (_m, url) => {
    routed = url.pathname + url.search;
    return { status: 200, headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([1, 2]) };
  });
  const r = await win.fetch('/thumb?key=42');
  assert.equal(routed, '/thumb?key=42');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2]));
});

test('everything else passes through to the real fetch', async () => {
  let seen = '';
  const win = fakeWin((async (u: string) => {
    seen = String(u);
    return new Response('ok');
  }) as typeof fetch);
  installFetchBridge(win, async () => {
    throw new Error('should not route');
  });
  await win.fetch('https://musicbrainz.org/ws/2/x');
  assert.equal(seen, 'https://musicbrainz.org/ws/2/x');
});

test('an outbound call that never answers fails with a TimeoutError', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const win = fakeWin((() => new Promise<Response>(() => {})) as typeof fetch);
  installFetchBridge(
    win,
    async () => {
      throw new Error('no');
    },
    { timeoutMs: 30_000 },
  );
  const p = win.fetch('https://plex.tv/api/v2/user');
  mock.timers.tick(30_000);
  await assert.rejects(p, (e: Error) => e.name === 'TimeoutError');
  mock.timers.reset();
});

test('a thumbnail loads as a local object URL', async () => {
  const load = thumbLoader((async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch);
  assert.match(await load('/thumb?key=1'), /^blob:/);
});

test('a missing thumbnail rejects, so the page can show its placeholder', async () => {
  const load = thumbLoader((async () => new Response(null, { status: 404 })) as typeof fetch);
  await assert.rejects(load('/thumb?key=1'));
});
