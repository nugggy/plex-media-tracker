/**
 * Signing in to the NAS server with Plex.
 *
 * Once the server listens on the network, and especially once the modem
 * forwards a port to it, anyone who finds it could change settings or read
 * the library. So every API call needs a session, and the only way to get one
 * is to sign in with the Plex account that owns the server.
 *
 * Signing in uses Plex's PIN flow, the same one Plex's own apps use. The
 * server asks plex.tv for a PIN, the person approves it on plex.tv, and the
 * server collects the account token that plex.tv then attaches to the PIN. The
 * password never passes through this app. The token is only used to ask
 * plex.tv who signed in; if that is the owner, a session of this app's own is
 * issued and the Plex token is dropped.
 *
 * A browser keeps its session in a cookie it cannot read from script. The
 * phone keeps it in app storage and sends it as a bearer token.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { db, getSetting, setSetting } from './db.ts';
import { APP_NAME, APP_VERSION } from './config.ts';
import { nowIso } from './dates.ts';

export const COOKIE = 'pmt_session';

/** A session not used for this long ends on its own. */
const IDLE_LIMIT_MS = 180 * 86_400_000;

/** last_seen_at is only written once an hour, so reading the dashboard does not write every second. */
const TOUCH_EVERY_MS = 3_600_000;

/** How long a PIN on plex.tv lasts when made with strong=true. */
const PIN_LIFE_MS = 15 * 60_000;

export type Device = 'browser' | 'phone';

export interface Session {
  account: string;
  device: Device;
  created_at: string;
  last_seen_at: string;
}

/* ---------------------------------------------------------------- headers */

type HeaderValue = string | string[] | undefined;

function one(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCookies(header: HeaderValue): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (one(header) ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface Credential {
  token: string;
  via: 'bearer' | 'cookie';
}

/** The session secret a request carries: the phone's bearer token first, then the browser's cookie. */
export function credentialFrom(headers: { authorization?: HeaderValue; cookie?: HeaderValue }): Credential | null {
  const auth = one(headers.authorization)?.trim();
  const bearer = auth?.match(/^Bearer\s+([A-Za-z0-9_-]{20,200})$/)?.[1];
  if (bearer) return { token: bearer, via: 'bearer' };
  const cookie = parseCookies(headers.cookie)[COOKIE];
  if (cookie && /^[A-Za-z0-9_-]{20,200}$/.test(cookie)) return { token: cookie, via: 'cookie' };
  return null;
}

/**
 * The cookie that carries a browser's session. HttpOnly keeps it out of
 * reach of script, and SameSite=Strict keeps other sites from sending it, so
 * a page elsewhere cannot act as the signed-in person. Secure is set whenever
 * the page was reached over https.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = Math.floor(IDLE_LIMIT_MS / 1000);
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** 10/8, 172.16/12, 192.168/16 and loopback, in IPv4 or IPv4-mapped IPv6 form. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.replace(/^::ffff:/i, '');
  if (v4 === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/* --------------------------------------------------------------- sessions */

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(account: string, device: Device): string {
  const token = randomBytes(32).toString('base64url');
  const now = nowIso();
  db.prepare(
    'INSERT INTO sessions (token_hash, account, device, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  ).run(hash(token), account, device, now, now);
  return token;
}

/** The session for a secret, or null when there is none or it has gone unused too long. */
export function findSession(token: string, now: number = Date.now()): Session | null {
  const key = hash(token);
  const row = db
    .prepare('SELECT account, device, created_at, last_seen_at FROM sessions WHERE token_hash = ?')
    .get(key) as Session | undefined;
  if (!row) return null;
  const seen = Date.parse(row.last_seen_at);
  if (Number.isNaN(seen) || now - seen > IDLE_LIMIT_MS) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(key);
    return null;
  }
  if (now - seen > TOUCH_EVERY_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), key);
  }
  return row;
}

export function endSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

/** The short public name of a session: the start of its hash, never the secret. */
function publicId(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}

export interface SessionInfo extends Session {
  id: string;
  current: boolean;
}

/** Every signed-in browser and phone, newest use first, for Settings. */
export function listSessions(currentToken: string | null): SessionInfo[] {
  const current = currentToken ? hash(currentToken) : '';
  const rows = db
    .prepare('SELECT token_hash, account, device, created_at, last_seen_at FROM sessions ORDER BY last_seen_at DESC')
    .all() as unknown as (Session & { token_hash: string })[];
  return rows.map(({ token_hash, ...rest }) => ({ ...rest, id: publicId(token_hash), current: token_hash === current }));
}

/** Ends one session by its public name. False when there was none. */
export function endSessionById(id: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  return Number(db.prepare("DELETE FROM sessions WHERE substr(token_hash, 1, 16) = ?").run(id).changes ?? 0) > 0;
}

/**
 * Lets the phone check that a plain-http address really is this server before
 * sending its token there. The phone names its session by the start of the
 * token's hash and sends a fresh nonce; only a server holding that hash can
 * answer, and the answer covers the name the phone used, so another server
 * cannot fetch the answer from this one and pass it off as its own.
 */
export function proveSession(id: string, nonce: string, host: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(id) || !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)) return null;
  const row = db.prepare('SELECT token_hash FROM sessions WHERE substr(token_hash, 1, 16) = ?').get(id) as
    | { token_hash: string }
    | undefined;
  if (!row) return null;
  return createHmac('sha256', row.token_hash).update(`${nonce}|${host.toLowerCase()}`).digest('hex');
}

/** Signs out every browser and phone, for when one has been lost. */
export function endAllSessions(): number {
  return Number(db.prepare('DELETE FROM sessions').run().changes ?? 0);
}

/* ---------------------------------------------------------------- plex.tv */

/** This server's own name to plex.tv. Made once, so plex.tv lists it as one device. */
export function clientId(): string {
  let id = getSetting('auth_client_id');
  if (!id) {
    id = `pmt-${randomBytes(12).toString('hex')}`;
    setSetting('auth_client_id', id);
  }
  return id;
}

function plexHeaders(token?: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': APP_NAME,
    'X-Plex-Version': APP_VERSION,
    'X-Plex-Client-Identifier': clientId(),
    ...(token ? { 'X-Plex-Token': token } : {}),
  };
}

/** The page on plex.tv where the person approves the PIN. */
export function approvalUrl(id: string, code: string): string {
  const params = new URLSearchParams({ clientID: id, code, 'context[device][product]': APP_NAME });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

export class SignInError extends Error {}

export interface PlexUser {
  uuid: string;
  name: string;
}

export async function whoIs(token: string, fetchFn: typeof fetch = fetch): Promise<PlexUser> {
  let res: Response;
  try {
    res = await fetchFn('https://plex.tv/api/v2/user', {
      headers: plexHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SignInError('Could not reach plex.tv. Try again in a minute.');
  }
  if (res.status === 401) throw new SignInError('plex.tv did not accept that sign-in.');
  if (!res.ok) throw new SignInError(`plex.tv answered HTTP ${res.status}. Try again in a minute.`);
  const data = (await res.json()) as { uuid?: string; username?: string; title?: string };
  if (!data.uuid) throw new SignInError('plex.tv did not say which account signed in.');
  return { uuid: data.uuid, name: data.username || data.title || 'your Plex account' };
}

/**
 * The account allowed in: the one whose token the app already uses to reach
 * Plex, which is the server's owner. Worked out once and remembered.
 */
export async function ownerUuid(fetchFn: typeof fetch = fetch): Promise<string | null> {
  const known = getSetting('auth_owner_uuid');
  if (known) return known;
  const token = getSetting('plex_token');
  if (!token) return null;
  const owner = await whoIs(token, fetchFn);
  setSetting('auth_owner_uuid', owner.uuid);
  return owner.uuid;
}

/* ------------------------------------------------------------ PIN tickets */

/**
 * PIN ids from plex.tv count upwards, so they are easy to guess. The page is
 * given a random ticket instead, and only the ticket can collect the result,
 * so nobody else can poll for a PIN the owner is approving and take the
 * session it produces.
 */
interface Ticket {
  pinId: number;
  device: Device;
  /** Who asked, by address, so one visitor cannot use up everyone's attempts. */
  client: string;
  /** The person asked from the home network, directly rather than through the proxy. */
  fromHome: boolean;
  expires: number;
}

const tickets = new Map<string, Ticket>();

/**
 * Limits per address, so a stranger hammering the sign-in button cannot stop
 * the owner signing in from anywhere else. The overall cap only bounds memory.
 */
const STARTS_PER_MINUTE = 5;
const TICKETS_PER_CLIENT = 5;
const MAX_TICKETS = 500;
let recentStarts: { client: string; at: number }[] = [];

function sweep(now: number): void {
  for (const [key, t] of tickets) if (t.expires < now) tickets.delete(key);
}

export async function startSignIn(
  device: Device,
  fromHome: boolean,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
  client = 'unknown',
): Promise<{ ticket: string; auth_url: string }> {
  sweep(now);
  recentStarts = recentStarts.filter((s) => now - s.at < 60_000);
  const mine = recentStarts.filter((s) => s.client === client).length;
  const live = [...tickets.values()].filter((t) => t.client === client).length;
  if (mine >= STARTS_PER_MINUTE || live >= TICKETS_PER_CLIENT || tickets.size >= MAX_TICKETS) {
    throw new SignInError('Too many sign-in attempts just now. Wait a minute and try again.');
  }
  recentStarts.push({ client, at: now });

  let res: Response;
  try {
    res = await fetchFn('https://plex.tv/api/v2/pins?strong=true', {
      method: 'POST',
      headers: plexHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SignInError('Could not reach plex.tv. Try again in a minute.');
  }
  if (!res.ok) throw new SignInError(`plex.tv answered HTTP ${res.status}. Try again in a minute.`);
  const pin = (await res.json()) as { id?: number; code?: string };
  if (typeof pin.id !== 'number' || !pin.code) throw new SignInError('plex.tv did not hand out a PIN.');

  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { pinId: pin.id, device, client, fromHome, expires: now + PIN_LIFE_MS });
  return { ticket, auth_url: approvalUrl(clientId(), pin.code) };
}

export type CheckResult =
  | { status: 'waiting' }
  | { status: 'expired' }
  | { status: 'refused'; message: string }
  | { status: 'done'; token: string; account: string; device: Device };

/**
 * Asks plex.tv whether the PIN behind a ticket has been approved. Once it has,
 * the account is checked against the owner and a session is made. A ticket
 * gives one answer only: approved, refused or expired, it is then forgotten.
 */
export async function checkSignIn(
  ticketKey: string,
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<CheckResult> {
  sweep(now);
  const ticket = tickets.get(ticketKey);
  if (!ticket) return { status: 'expired' };
  // One check at a time per ticket, so two overlapping polls of an approved
  // PIN cannot each make a session.
  if (checking.has(ticketKey)) return { status: 'waiting' };
  checking.add(ticketKey);
  try {
    return await checkTicket(ticketKey, ticket, fetchFn);
  } finally {
    checking.delete(ticketKey);
  }
}

const checking = new Set<string>();

async function checkTicket(ticketKey: string, ticket: Ticket, fetchFn: typeof fetch): Promise<CheckResult> {

  let res: Response;
  try {
    res = await fetchFn(`https://plex.tv/api/v2/pins/${ticket.pinId}`, {
      headers: plexHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A blip talking to plex.tv is not an answer. The page asks again.
    return { status: 'waiting' };
  }
  if (res.status === 404) {
    tickets.delete(ticketKey);
    return { status: 'expired' };
  }
  if (!res.ok) return { status: 'waiting' };
  const pin = (await res.json()) as { authToken?: string | null };
  if (!pin.authToken) return { status: 'waiting' };
  tickets.delete(ticketKey);

  try {
    const user = await whoIs(pin.authToken, fetchFn);
    const owner = await ownerUuid(fetchFn);
    if (owner === null) {
      // A brand new server with no Plex account yet. Whoever signs in first
      // becomes the owner, but only from the home network, so a stranger who
      // finds a fresh install through the forwarded port cannot claim it.
      if (!ticket.fromHome) {
        return {
          status: 'refused',
          message: 'This server has not been set up yet. Sign in for the first time from your home network.',
        };
      }
      setSetting('auth_owner_uuid', user.uuid);
      setSetting('plex_token', pin.authToken);
    } else if (user.uuid !== owner) {
      return {
        status: 'refused',
        message: `${user.name} is not the Plex account this server belongs to. Sign in with the owner's account.`,
      };
    }
    const token = createSession(user.name, ticket.device);
    return { status: 'done', token, account: user.name, device: ticket.device };
  } catch (err) {
    return { status: 'refused', message: (err as Error).message };
  }
}

/** For tests: forget every ticket and start count. */
export function resetSignInState(): void {
  tickets.clear();
  checking.clear();
  recentStarts = [];
}
