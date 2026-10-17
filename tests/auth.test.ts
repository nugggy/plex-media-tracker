import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PLEX_TRACKER_DATA_DIR = mkdtempSync(join(tmpdir(), 'pmt-auth-'));
const auth = await import('../src/auth.ts');
const store = await import('../src/db.ts');

const OWNER = { uuid: 'owner-uuid', username: 'nuggy' };
const STRANGER = { uuid: 'someone-else', username: 'stranger' };

/** A stand-in for plex.tv: one PIN, approved by whichever account `approver` names. */
function plexTv(opts: { approver?: typeof OWNER | null; tokenOwner?: typeof OWNER } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(`${init.method ?? 'GET'} ${url}`);
    const headers = new Headers(init.headers);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://plex.tv/api/v2/pins?')) return json({ id: 4242, code: 'abcd' });
    if (url === 'https://plex.tv/api/v2/pins/4242') {
      return json({ authToken: opts.approver ? `token-of-${opts.approver.uuid}` : null });
    }
    if (url === 'https://plex.tv/api/v2/user') {
      const token = headers.get('X-Plex-Token');
      if (token === 'stored-server-token') return json(opts.tokenOwner ?? OWNER);
      if (token === `token-of-${OWNER.uuid}`) return json(OWNER);
      if (token === `token-of-${STRANGER.uuid}`) return json(STRANGER);
      return json({}, 401);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, calls };
}

beforeEach(() => {
  auth.resetSignInState();
  store.db.exec('DELETE FROM sessions');
  for (const key of ['auth_owner_uuid', 'plex_token']) store.setSetting(key, '');
});

test('the owner signs in and gets a session that is then found by its secret', async () => {
  store.setSetting('plex_token', 'stored-server-token');
  const { fetchFn } = plexTv({ approver: OWNER });
  const { ticket, auth_url } = await auth.startSignIn('phone', false, fetchFn);
  assert.match(auth_url, /^https:\/\/app\.plex\.tv\/auth#\?clientID=pmt-[0-9a-f]+&code=abcd/);

  const result = await auth.checkSignIn(ticket, fetchFn);
  assert.equal(result.status, 'done');
  if (result.status !== 'done') return;
  assert.equal(result.account, 'nuggy');
  assert.equal(result.device, 'phone');
  assert.equal(auth.findSession(result.token)?.account, 'nuggy');

  // Only a hash of the secret is stored.
  const stored = store.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.token_hash, result.token);
});

test('a ticket waits until the PIN is approved, then answers once only', async () => {
  store.setSetting('plex_token', 'stored-server-token');
  const waiting = plexTv({ approver: null });
  const { ticket } = await auth.startSignIn('browser', false, waiting.fetchFn);
  assert.deepEqual(await auth.checkSignIn(ticket, waiting.fetchFn), { status: 'waiting' });

  const approved = plexTv({ approver: OWNER });
  assert.equal((await auth.checkSignIn(ticket, approved.fetchFn)).status, 'done');
  assert.deepEqual(await auth.checkSignIn(ticket, approved.fetchFn), { status: 'expired' });
});

test('a made-up ticket gets nothing, even for a PIN that was approved', async () => {
  const { fetchFn, calls } = plexTv({ approver: OWNER });
  assert.deepEqual(await auth.checkSignIn('not-a-real-ticket', fetchFn), { status: 'expired' });
  assert.equal(calls.length, 0);
});

test('another Plex account is refused', async () => {
  store.setSetting('plex_token', 'stored-server-token');
  const { fetchFn } = plexTv({ approver: STRANGER });
  const { ticket } = await auth.startSignIn('browser', true, fetchFn);
  const result = await auth.checkSignIn(ticket, fetchFn);
  assert.equal(result.status, 'refused');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0);
});

test('a fresh server can only be claimed from the home network', async () => {
  const { fetchFn } = plexTv({ approver: STRANGER });
  const away = await auth.startSignIn('browser', false, fetchFn);
  const refused = await auth.checkSignIn(away.ticket, fetchFn);
  assert.equal(refused.status, 'refused');
  assert.equal(store.getSetting('auth_owner_uuid'), '');

  const home = await auth.startSignIn('browser', true, plexTv({ approver: OWNER }).fetchFn);
  const claimed = await auth.checkSignIn(home.ticket, plexTv({ approver: OWNER }).fetchFn);
  assert.equal(claimed.status, 'done');
  assert.equal(store.getSetting('auth_owner_uuid'), OWNER.uuid);
  // The owner's token is kept so Settings can go straight on to picking a server.
  assert.equal(store.getSetting('plex_token'), `token-of-${OWNER.uuid}`);
});

test('a session unused for half a year has ended', () => {
  const token = auth.createSession('nuggy', 'browser');
  const later = Date.now() + 181 * 86_400_000;
  assert.equal(auth.findSession(token, later), null);
  assert.equal(auth.findSession(token), null);
});

test('signing out ends that session, and signing out everywhere ends them all', () => {
  const a = auth.createSession('nuggy', 'browser');
  const b = auth.createSession('nuggy', 'phone');
  auth.endSession(a);
  assert.equal(auth.findSession(a), null);
  assert.ok(auth.findSession(b));
  auth.createSession('nuggy', 'browser');
  assert.equal(auth.endAllSessions(), 2);
  assert.equal(auth.findSession(b), null);
});

test('sign-in starts are limited per address, so one visitor cannot lock the owner out', async () => {
  store.setSetting('plex_token', 'stored-server-token');
  const { fetchFn } = plexTv();
  const now = Date.now();
  for (let i = 0; i < 5; i++) await auth.startSignIn('browser', false, fetchFn, now, '203.0.113.9');
  await assert.rejects(auth.startSignIn('browser', false, fetchFn, now, '203.0.113.9'), auth.SignInError);
  // A minute later the same address still holds five live tickets, so still no.
  await assert.rejects(auth.startSignIn('browser', false, fetchFn, now + 61_000, '203.0.113.9'), auth.SignInError);
  // The owner, from anywhere else, is unaffected.
  assert.ok((await auth.startSignIn('phone', false, fetchFn, now, '198.51.100.7')).ticket);
});

test('two overlapping checks of an approved PIN make one session, not two', async () => {
  store.setSetting('plex_token', 'stored-server-token');
  const { fetchFn } = plexTv({ approver: OWNER });
  const { ticket } = await auth.startSignIn('phone', false, fetchFn);
  const results = await Promise.all([auth.checkSignIn(ticket, fetchFn), auth.checkSignIn(ticket, fetchFn)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['done', 'waiting']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1);
});

test('the secret is read from a bearer header or the cookie, and nothing malformed', () => {
  const secret = 'A'.repeat(43);
  assert.deepEqual(auth.credentialFrom({ authorization: `Bearer ${secret}` }), { token: secret, via: 'bearer' });
  assert.deepEqual(auth.credentialFrom({ cookie: `other=1; pmt_session=${secret}` }), { token: secret, via: 'cookie' });
  assert.equal(auth.credentialFrom({ authorization: 'Bearer short' }), null);
  assert.equal(auth.credentialFrom({ cookie: 'pmt_session=has spaces and more than twenty' }), null);
});

test('the cookie cannot be read by script or sent by other sites', () => {
  const c = auth.sessionCookie('x'.repeat(43), true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(auth.sessionCookie('x'.repeat(43), false), /Secure/);
});

test('home addresses are told apart from the internet', () => {
  for (const a of ['192.168.0.20', '::ffff:10.0.3.1', '172.20.1.1', '127.0.0.1', '::1']) {
    assert.ok(auth.isPrivateAddress(a), a);
  }
  for (const a of ['203.0.113.5', '::ffff:8.8.8.8', '172.32.0.1', undefined, '2001:db8::1']) {
    assert.ok(!auth.isPrivateAddress(a), String(a));
  }
});

test('a server proves it holds a session only for that session, and only for the name it was asked by', async () => {
  const token = auth.createSession('nuggy', 'phone');
  const { createHash, createHmac } = await import('node:crypto');
  const h = createHash('sha256').update(token).digest('hex');
  const nonce = 'n'.repeat(32);
  assert.equal(
    auth.proveSession(h.slice(0, 16), nonce, '192.168.0.162:7000'),
    createHmac('sha256', h).update(`${nonce}|192.168.0.162:7000`).digest('hex'),
  );
  assert.notEqual(
    auth.proveSession(h.slice(0, 16), nonce, 'music.example.org'),
    auth.proveSession(h.slice(0, 16), nonce, '192.168.0.162:7000'),
  );
  assert.equal(auth.proveSession('0'.repeat(16), nonce, 'x'), null);
  assert.equal(auth.proveSession(h.slice(0, 16), 'short', 'x'), null);
});

test('Settings can list the sessions and end one by its short name', () => {
  const mine = auth.createSession('nuggy', 'browser');
  auth.createSession('nuggy', 'phone');
  const list = auth.listSessions(mine);
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.current).length, 1);
  const phone = list.find((s) => s.device === 'phone')!;
  assert.match(phone.id, /^[0-9a-f]{16}$/);
  assert.equal(auth.endSessionById(phone.id), true);
  assert.equal(auth.listSessions(mine).length, 1);
  assert.equal(auth.endSessionById("' OR 1=1 --"), false);
});
