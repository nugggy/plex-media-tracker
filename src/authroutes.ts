/**
 * The sign-in endpoints, and the check every other API call passes on the NAS
 * server. Kept apart from api.ts because these need the request's headers and
 * address and set cookies, which nothing else does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTH_REQUIRED, LAN_URL, TRUST_PROXY } from './config.ts';
import { APP_VERSION } from './version.ts';
import { send, readJson } from './api.ts';
import {
  checkSignIn,
  clearedCookie,
  credentialFrom,
  endAllSessions,
  endSession,
  endSessionById,
  listSessions,
  proveSession,
  findSession,
  isPrivateAddress,
  sessionCookie,
  SignInError,
  startSignIn,
  type Device,
  type Session,
} from './auth.ts';

/** Paths anyone may call: the ones needed to sign in, and the container's health check. */
const OPEN_PATHS = new Set([
  '/api/health',
  '/api/auth/status',
  '/api/auth/start',
  '/api/auth/check',
  '/api/auth/signout',
  '/api/auth/prove',
]);

export function isOpenPath(path: string): boolean {
  return OPEN_PATHS.has(path);
}

/** Whether the page was reached over https, directly or through the proxy. */
export function isSecure(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (!TRUST_PROXY) return false;
  const proto = req.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https';
}

/**
 * True when the request came straight from a device on the home network.
 * Anything through the proxy carries X-Forwarded-For and does not count, even
 * though the proxy itself has a private address.
 */
export function isFromHome(req: IncomingMessage): boolean {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  return isPrivateAddress(req.socket.remoteAddress);
}

/** The visitor's address: the real one Caddy saw, or the socket's own. */
export function clientAddress(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Caddy appends the address it saw, so the last entry is the one to trust.
  if (TRUST_PROXY && list.length > 0) return list[list.length - 1]!;
  return req.socket.remoteAddress ?? 'unknown';
}

/** The session behind a request, or null. */
export function sessionOf(req: IncomingMessage): Session | null {
  const cred = credentialFrom(req.headers);
  return cred ? findSession(cred.token) : null;
}

export function usesBearer(req: IncomingMessage): boolean {
  return credentialFrom(req.headers)?.via === 'bearer';
}

export function refuseUnsigned(res: ServerResponse): void {
  send(res, 401, { error: 'Sign in with Plex to continue.', signin: true });
}

function deviceFrom(value: unknown): Device {
  return value === 'phone' ? 'phone' : 'browser';
}

/** Handles the auth and health paths. False for anything else. */
export async function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    send(res, 200, { ok: true, version: APP_VERSION });
    return true;
  }

  if (route === 'GET /api/auth/status') {
    const session = AUTH_REQUIRED ? sessionOf(req) : null;
    send(res, 200, {
      required: AUTH_REQUIRED,
      signed_in: !AUTH_REQUIRED || session !== null,
      account: session?.account ?? null,
      device: session?.device ?? null,
      // The home address is only handed to someone already signed in.
      lan_url: session || !AUTH_REQUIRED ? LAN_URL || null : null,
      version: APP_VERSION,
    });
    return true;
  }

  if (route === 'POST /api/auth/start') {
    if (!AUTH_REQUIRED) {
      send(res, 400, { error: 'This server does not need signing in.' });
      return true;
    }
    const body = await readJson(req);
    try {
      send(res, 200, await startSignIn(deviceFrom(body.device), isFromHome(req), fetch, Date.now(), clientAddress(req)));
    } catch (err) {
      send(res, err instanceof SignInError ? 503 : 500, { error: (err as Error).message });
    }
    return true;
  }

  if (route === 'POST /api/auth/check') {
    const body = await readJson(req);
    const result = await checkSignIn(String(body.ticket ?? ''));
    if (result.status !== 'done') {
      send(res, 200, result);
      return true;
    }
    if (result.device === 'phone') {
      // The phone stores this and sends it as a bearer token from now on.
      send(res, 200, { status: 'done', account: result.account, token: result.token });
      return true;
    }
    res.setHeader('Set-Cookie', sessionCookie(result.token, isSecure(req)));
    send(res, 200, { status: 'done', account: result.account });
    return true;
  }

  if (route === 'POST /api/auth/signout') {
    const cred = credentialFrom(req.headers);
    if (cred) endSession(cred.token);
    res.setHeader('Set-Cookie', clearedCookie(isSecure(req)));
    send(res, 200, { ok: true });
    return true;
  }

  if (route === 'GET /api/auth/prove') {
    const host = req.headers.host ?? '';
    const proof = proveSession(url.searchParams.get('id') ?? '', url.searchParams.get('nonce') ?? '', host);
    if (!proof) send(res, 404, { error: 'No such session.' });
    else send(res, 200, { proof });
    return true;
  }

  if (route === 'GET /api/auth/sessions') {
    send(res, 200, { sessions: listSessions(credentialFrom(req.headers)?.token ?? null) });
    return true;
  }

  if (route === 'POST /api/auth/sessions/end') {
    const body = await readJson(req);
    send(res, 200, { ended: endSessionById(String(body.id ?? '')) });
    return true;
  }

  if (route === 'POST /api/auth/signout-all') {
    // Reached only with a session, since this path is not an open one.
    const ended = endAllSessions();
    res.setHeader('Set-Cookie', clearedCookie(isSecure(req)));
    send(res, 200, { ok: true, ended });
    return true;
  }

  return false;
}
