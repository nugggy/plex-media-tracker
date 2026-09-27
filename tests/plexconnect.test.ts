import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResources,
  orderConnections,
  pickConnection,
  probeIdentity,
  resourcesUrl,
  retryOnUnreachable,
  type PlexConnection,
} from '../src/plexconnect.ts';
import { PlexError, PlexUnreachable } from '../src/plex.ts';

/** The shape clients.plex.tv returns, trimmed to the fields that matter. */
const RESOURCES = [
  {
    name: 'Lounge',
    provides: 'server',
    clientIdentifier: 'abc123',
    owned: true,
    connections: [
      { uri: 'https://203-0-113-5.abc123.plex.direct:32400', local: false, relay: false },
      { uri: 'http://192.168.1.10:32400', local: true, relay: false },
      { uri: 'https://138-199-1-1.abc123.plex.direct:8443', local: false, relay: true },
      { uri: 'https://192-168-1-10.abc123.plex.direct:32400', local: true, relay: false },
      { uri: 'http://203.0.113.5:32400', local: false, relay: false },
    ],
  },
  { name: 'Phone', provides: 'client,player', clientIdentifier: 'p1', owned: true, connections: [] },
  {
    name: 'A friend',
    provides: 'server',
    clientIdentifier: 'f1',
    owned: false,
    connections: [{ uri: 'https://x.f1.plex.direct:32400', local: false, relay: false }],
  },
];

test('only servers you own are listed', () => {
  const servers = parseResources(RESOURCES);
  assert.deepEqual(
    servers.map((s) => [s.machineId, s.name]),
    [['abc123', 'Lounge']],
  );
});

test('a payload that is not a list gives no servers', () => {
  assert.deepEqual(parseResources({ error: 'nope' }), []);
  assert.deepEqual(parseResources(null), []);
});

test('connections go local, then remote, then relay', () => {
  const [server] = parseResources(RESOURCES);
  assert.deepEqual(
    orderConnections(server.connections).map((c) => c.uri),
    [
      'https://192-168-1-10.abc123.plex.direct:32400',
      'http://192.168.1.10:32400',
      'https://203-0-113-5.abc123.plex.direct:32400',
      'https://138-199-1-1.abc123.plex.direct:8443',
    ],
  );
});

test('a remote address over plain http is never used, because the token would travel in the clear', () => {
  const [server] = parseResources(RESOURCES);
  const uris = orderConnections(server.connections).map((c) => c.uri);
  assert.equal(uris.includes('http://203.0.113.5:32400'), false);
});

test('the resources request asks for https and relay addresses', () => {
  const url = new URL(resourcesUrl());
  assert.equal(url.host, 'clients.plex.tv');
  assert.equal(url.searchParams.get('includeHttps'), '1');
  assert.equal(url.searchParams.get('includeRelay'), '1');
});

const LOCAL: PlexConnection = { uri: 'http://192.168.1.10:32400', local: true, relay: false };
const REMOTE: PlexConnection = { uri: 'https://remote.plex.direct:32400', local: false, relay: false };
const RELAY: PlexConnection = { uri: 'https://relay.plex.direct:8443', local: false, relay: true };

test('at home the local address wins even when the remote one also answers', async () => {
  const picked = await pickConnection([LOCAL, REMOTE, RELAY], async () => true);
  assert.equal(picked?.uri, LOCAL.uri);
});

test('away from home the remote address is used when the local one does not answer', async () => {
  const picked = await pickConnection([LOCAL, REMOTE, RELAY], async (c) => c !== LOCAL);
  assert.equal(picked?.uri, REMOTE.uri);
});

test('the relay is the last resort', async () => {
  const picked = await pickConnection([LOCAL, REMOTE, RELAY], async (c) => c === RELAY);
  assert.equal(picked?.uri, RELAY.uri);
});

test('nothing answering gives no connection', async () => {
  assert.equal(await pickConnection([LOCAL, REMOTE], async () => false), null);
});

test('addresses are tried together, not one after another', async () => {
  let inFlight = 0;
  let peak = 0;
  await pickConnection([LOCAL, REMOTE, RELAY], async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    return false;
  });
  assert.equal(peak, 3);
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

test('an address answers only when it is the server we asked for', async () => {
  const ok = fakeFetch(200, { MediaContainer: { machineIdentifier: 'abc123' } });
  assert.equal(await probeIdentity(LOCAL.uri, 'abc123', ok), true);
  // Something else on another network at the same private address.
  assert.equal(await probeIdentity(LOCAL.uri, 'other', ok), false);
});

test('an address that errors or refuses does not answer', async () => {
  assert.equal(await probeIdentity(LOCAL.uri, 'abc123', fakeFetch(500, {})), false);
  const refused = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal(await probeIdentity(LOCAL.uri, 'abc123', refused), false);
});

test('losing the server partway through finds the new address and tries again', async () => {
  let url = 'http://192.168.1.10:32400';
  const tried: string[] = [];
  const result = await retryOnUnreachable(
    async (u) => {
      tried.push(u);
      if (u.startsWith('http://192')) throw new PlexUnreachable('gone');
      return 'done';
    },
    () => url,
    async () => {
      url = 'https://remote.plex.direct:32400';
    },
  );
  assert.equal(result, 'done');
  assert.deepEqual(tried, ['http://192.168.1.10:32400', 'https://remote.plex.direct:32400']);
});

test('no second go when the lookup lands on the same address', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnUnreachable(
      async () => {
        calls += 1;
        throw new PlexUnreachable('gone');
      },
      () => 'https://same.plex.direct:32400',
      async () => {},
    ),
    PlexUnreachable,
  );
  assert.equal(calls, 1);
});

test('Plex answering with an error is not retried', async () => {
  let looked = false;
  await assert.rejects(
    retryOnUnreachable(
      async () => {
        throw new PlexError('Plex rejected the token.');
      },
      () => 'x',
      async () => {
        looked = true;
      },
    ),
    PlexError,
  );
  assert.equal(looked, false);
});
