import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResources,
  orderConnections,
  pickConnection,
  probeIdentity,
  probeOutcome,
  describeNoAnswer,
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

/**
 * What a real server sends with includeHttps=1: every address, the LAN one
 * included, only as a plex.direct name. A phone whose DNS will not resolve that
 * name to a home address, and a router with no NAT loopback for the public one,
 * leave nothing that works at home. So the bare LAN address is added too.
 */
test('a LAN address listed only as plex.direct also gets a plain one that needs no DNS', () => {
  const [server] = parseResources([
    {
      name: 'Home',
      provides: 'server',
      clientIdentifier: 'h1',
      owned: true,
      connections: [
        { uri: 'https://192-168-0-162.h1.plex.direct:32400', protocol: 'https', address: '192.168.0.162', port: 32400, local: true },
        { uri: 'https://10-0-5-1.h1.plex.direct:32400', protocol: 'https', address: '10.0.5.1', port: 32400, local: true },
        { uri: 'https://203-0-113-5.h1.plex.direct:20972', protocol: 'https', address: '203.0.113.5', port: 20972, local: false },
        { uri: 'https://138-199-1-1.h1.plex.direct:8443', protocol: 'https', address: '138.199.1.1', port: 8443, relay: true },
      ],
    },
  ]);
  assert.deepEqual(
    orderConnections(server.connections).map((c) => c.uri),
    [
      'https://192-168-0-162.h1.plex.direct:32400',
      'https://10-0-5-1.h1.plex.direct:32400',
      'http://192.168.0.162:32400',
      'http://10.0.5.1:32400',
      'https://203-0-113-5.h1.plex.direct:20972',
      'https://138-199-1-1.h1.plex.direct:8443',
    ],
  );
});

test('a plain address is never made up for a public IP, even one marked local', () => {
  const [server] = parseResources([
    {
      name: 'Odd',
      provides: 'server',
      clientIdentifier: 'o1',
      owned: true,
      connections: [{ uri: 'https://203-0-113-5.o1.plex.direct:32400', address: '203.0.113.5', port: 32400, local: true }],
    },
  ]);
  assert.deepEqual(
    server.connections.map((c) => c.uri),
    ['https://203-0-113-5.o1.plex.direct:32400'],
  );
});

test('a plain LAN address already listed is not added twice', () => {
  const [server] = parseResources(RESOURCES);
  const uris = server.connections.map((c) => c.uri);
  assert.equal(uris.filter((u) => u === 'http://192.168.1.10:32400').length, 1);
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

const NEVER = new Promise<boolean>(() => {});

test('the best address answering is taken at once, without waiting on the rest', async () => {
  const picked = await pickConnection([LOCAL, REMOTE, RELAY], (c) =>
    c === LOCAL ? Promise.resolve(true) : NEVER,
  );
  assert.equal(picked?.uri, LOCAL.uri);
});

test('a lower address is taken once every address above it has said no', async () => {
  const picked = await pickConnection([LOCAL, REMOTE, RELAY], (c) =>
    c === RELAY ? NEVER : Promise.resolve(c === REMOTE),
  );
  assert.equal(picked?.uri, REMOTE.uri);
});

test('a lower address answering first still waits for the one above it', async () => {
  let localAsked = false;
  const picked = await pickConnection([LOCAL, REMOTE], async (c) => {
    if (c === REMOTE) return true;
    await new Promise((r) => setTimeout(r, 20));
    localAsked = true;
    return true;
  });
  assert.equal(localAsked, true);
  assert.equal(picked?.uri, LOCAL.uri);
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

/*
 * When nothing answers, the reason per address is what tells a phone at home
 * apart from a phone away, so the message names every address and why it
 * failed instead of only saying that none answered.
 */
test('each address reports why it did not answer', async () => {
  const timeout = (async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  }) as typeof fetch;
  const refused = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  assert.equal(await probeOutcome(LOCAL.uri, 'abc123', timeout), 'no answer in 5 s');
  assert.equal(await probeOutcome(LOCAL.uri, 'abc123', refused), 'could not connect');
  assert.equal(await probeOutcome(LOCAL.uri, 'abc123', fakeFetch(401, {})), 'HTTP 401');
  assert.equal(
    await probeOutcome(LOCAL.uri, 'other', fakeFetch(200, { MediaContainer: { machineIdentifier: 'abc123' } })),
    'a different server',
  );
  assert.equal(
    await probeOutcome(LOCAL.uri, 'abc123', fakeFetch(200, { MediaContainer: { machineIdentifier: 'abc123' } })),
    'ok',
  );
});

test('the failure message lists every address with its reason, in the order tried', () => {
  const message = describeNoAnswer('Lounge', [
    { uri: 'https://192-168-1-10.8b09d56f474443b5b65e099d47345d0c.plex.direct:32400', outcome: 'could not connect' },
    { uri: 'http://192.168.1.10:32400', outcome: 'no answer in 5 s' },
    { uri: 'https://203-0-113-5.8b09d56f474443b5b65e099d47345d0c.plex.direct:32400', outcome: 'HTTP 401' },
  ]);
  assert.match(message, /^Lounge did not answer at any of its addresses\./);
  assert.match(message, /192-168-1-10\.….plex\.direct:32400: could not connect/);
  assert.match(message, /192\.168\.1\.10:32400: no answer in 5 s/);
  assert.match(message, /203-0-113-5\.….plex\.direct:32400: HTTP 401/);
  assert.ok(message.indexOf('192-168-1-10') < message.indexOf('192.168.1.10'));
  assert.ok(!message.includes('8b09d56f'));
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
