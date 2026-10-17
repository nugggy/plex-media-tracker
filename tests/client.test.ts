import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, hmacHex, normaliseServer, type KeyStore, type OfflineCache, type ConnectionStatus } from '../mobile/client.ts';

function memoryStore(init: Record<string, string> = {}): KeyStore & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      if (v === null) delete data[k];
      else data[k] = v;
    },
  };
}

function memoryCache(): OfflineCache & { keys: () => string[] } {
  const map = new Map<string, Response>();
  return {
    keys: () => [...map.keys()],
    put: async (k, r) => void map.set(k, r),
    match: async (k) => map.get(k)?.clone(),
    clear: async () => map.clear(),
  };
}

const PUBLIC = 'https://music.example.org';
const HOME = 'http://192.168.0.162:7000';

/** A network where only the listed origins answer. */
function network(up: string[], seen: { url: string; auth: string | null }[] = []) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init.headers).get('Authorization') });
    if (!up.some((o) => url.startsWith(o))) throw new TypeError('Failed to fetch');
    return Response.json(
      { from: new URL(url).origin, path: new URL(url).pathname },
      { headers: { 'X-PMT-Server': '1' } },
    );
  }) as typeof fetch;
}

test('an address is tidied into an origin, with https assumed', () => {
  assert.equal(normaliseServer('music.example.org/'), PUBLIC);
  assert.equal(normaliseServer(' https://music.example.org/anything?x=1 '), PUBLIC);
  assert.equal(normaliseServer(HOME + '/'), HOME);
  assert.equal(normaliseServer('ftp://x'), null);
  assert.equal(normaliseServer('https://me:pw@music.example.org'), null);
  assert.equal(normaliseServer(''), null);
});

test('calls go to the server with the bearer token', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const client = createClient({
    fetch: network([PUBLIC], seen),
    store: memoryStore({ 'server-url': PUBLIC, 'session-token': 'secret-token' }),
    cache: null,
  });
  const r = await client.request('GET', '/api/state', null, null);
  assert.deepEqual(await r.json(), { from: PUBLIC, path: '/api/state' });
  assert.deepEqual(seen, [{ url: `${PUBLIC}/api/state`, auth: 'Bearer secret-token' }]);
});

test('with no server chosen yet, the page is told to ask for one', async () => {
  const client = createClient({ fetch: network([]), store: memoryStore(), cache: null });
  const r = await client.request('GET', '/api/state', null, null);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).setup, true);
});

test('when the public address fails at home, the home address is used and remembered', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const store = memoryStore({ 'server-url': PUBLIC, 'server-lan-url': HOME });
  const client = createClient({ fetch: network([HOME], seen), store, cache: null });
  assert.equal((await (await client.request('GET', '/api/state', null, null)).json()).from, HOME);
  seen.length = 0;
  await client.request('GET', '/api/releases', null, null);
  assert.deepEqual(seen.map((s) => s.url), [`${HOME}/api/releases`]);

  // Back on the app after a while, the public address goes first again.
  client.preferPublic();
  seen.length = 0;
  await client.request('GET', '/api/releases', null, null);
  assert.deepEqual(seen.map((s) => s.url), [`${PUBLIC}/api/releases`, `${HOME}/api/releases`]);
});

test('offline, a GET gets the last saved answer and the page is told when it was saved', async () => {
  const store = memoryStore({ 'server-url': PUBLIC });
  const cache = memoryCache();
  const statuses: ConnectionStatus[] = [];
  let up = true;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) =>
    up ? network([PUBLIC])(input, init) : network([])(input, init)) as typeof fetch;
  const client = createClient({
    fetch: fetchFn,
    store,
    cache,
    onStatus: (s) => statuses.push(s),
    now: () => new Date('2026-10-17T03:30:00Z'),
  });

  await client.request('GET', '/api/releases?view=out', null, null);
  up = false;
  const r = await client.request('GET', '/api/releases?view=out', null, null);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).path, '/api/releases');
  assert.deepEqual(statuses.at(-1), { offline: true, savedAt: '2026-10-17T03:30:00.000Z' });

  up = true;
  await client.request('GET', '/api/state', null, null);
  assert.deepEqual(statuses.at(-1), { offline: false, savedAt: null });
});

test('offline, a change is refused rather than lost, and live progress is never saved', async () => {
  const cache = memoryCache();
  const client = createClient({
    fetch: network([PUBLIC]),
    store: memoryStore({ 'server-url': PUBLIC }),
    cache,
  });
  await client.request('GET', '/api/lyrics/progress', null, null);
  await client.request('GET', '/api/dash/sessions', null, null);
  await client.request('GET', '/api/auth/status', null, null);
  await client.request('POST', '/api/scan/start', '{}', 'application/json');
  assert.deepEqual(cache.keys(), []);

  const offline = createClient({ fetch: network([]), store: memoryStore({ 'server-url': PUBLIC }), cache });
  const r = await offline.request('POST', '/api/releases/dismiss', '{}', 'application/json');
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /nothing was changed/);
});

test('a new server address signs the phone out and forgets the old saved copies', async () => {
  const store = memoryStore({ 'server-url': PUBLIC, 'session-token': 't', 'server-lan-url': HOME });
  const cache = memoryCache();
  await cache.put('/api/state', new Response('{}'));
  const client = createClient({ fetch: network([]), store, cache });
  assert.equal(client.setServer('other.example.org'), 'https://other.example.org');
  assert.equal(client.hasToken(), false);
  assert.equal(client.lanUrl(), null);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(cache.keys(), []);
  // The same address again changes nothing.
  client.setToken('kept');
  client.setServer('https://other.example.org/');
  assert.equal(client.hasToken(), true);
});

/** A home server at HOME. `holds` is the token it has a session for, or null for a stranger's machine. */
function homeServer(holds: string | null, seen: { url: string; auth: string | null }[]) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url: String(input), auth: new Headers(init.headers).get('Authorization') });
    if (url.origin !== HOME) throw new TypeError('Failed to fetch');
    if (url.pathname === '/api/auth/prove') {
      if (!holds) return Response.json({ error: 'No such session.' }, { status: 404 });
      const h = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(holds))).toString('hex');
      if (url.searchParams.get('id') !== h.slice(0, 16)) return Response.json({}, { status: 404 });
      return Response.json(
        { proof: await hmacHex(h, `${url.searchParams.get('nonce')}|${url.host}`) },
        { headers: { 'X-PMT-Server': '1' } },
      );
    }
    return Response.json({ from: url.origin }, { headers: { 'X-PMT-Server': '1' } });
  }) as typeof fetch;
}

const TOKEN = 'T'.repeat(43);

test('the token goes to the home address only once that server proves it holds the session', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const client = createClient({
    fetch: homeServer(TOKEN, seen),
    store: memoryStore({ 'server-url': PUBLIC, 'server-lan-url': HOME, 'session-token': TOKEN }),
    cache: null,
  });
  assert.equal((await (await client.request('GET', '/api/state', null, null)).json()).from, HOME);
  const prove = seen.find((s) => s.url.includes('/api/auth/prove'))!;
  assert.equal(prove.auth, null);
  assert.equal(seen.at(-1)!.auth, `Bearer ${TOKEN}`);
});

test("a stranger's machine at the same home address never sees the token", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const client = createClient({
    fetch: homeServer(null, seen),
    store: memoryStore({ 'server-url': PUBLIC, 'server-lan-url': HOME, 'session-token': TOKEN }),
    cache: null,
  });
  const r = await client.request('GET', '/api/state', null, null);
  assert.equal(r.status, 503);
  assert.ok(seen.filter((s) => s.url.startsWith(HOME)).every((s) => s.auth === null));
  assert.ok(!seen.some((s) => s.url === `${HOME}/api/state`));
});

test('a change that timed out is not sent again another way', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const e = new Error('No answer');
    e.name = 'TimeoutError';
    throw e;
  }) as typeof fetch;
  const client = createClient({
    fetch: fetchFn,
    store: memoryStore({ 'server-url': PUBLIC, 'server-lan-url': HOME }),
    cache: null,
  });
  const r = await client.request('POST', '/api/scan/start', '{}', 'application/json');
  assert.equal(r.status, 504);
  assert.deepEqual(seen, [`${PUBLIC}/api/scan/start`]);
});

test("at home, the modem's own login page at the public address is passed over for the home address", async () => {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.origin === PUBLIC) return new Response('<h1>401 Authorization Required</h1>nginx', { status: 401 });
    return Response.json({ from: url.origin }, { headers: { 'X-PMT-Server': '1' } });
  }) as typeof fetch;
  const client = createClient({
    fetch: fetchFn,
    store: memoryStore({ 'server-url': PUBLIC, 'server-lan-url': HOME }),
    cache: null,
  });
  const r = await client.request('GET', '/api/auth/status', null, null);
  assert.equal((await r.json()).from, HOME);
});
