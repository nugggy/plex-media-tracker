/**
 * Which requests the PC server will hand to the API.
 *
 * The server only listens on loopback, but a web page open in any browser tab
 * can still aim requests at localhost. Two tricks matter. A page on another
 * site can send a POST here (a form or a fetch with a simple content type),
 * which would change settings or start jobs with nobody asking. And a site
 * whose name has been pointed at 127.0.0.1 (DNS rebinding) can read the
 * answers too, because the browser thinks it is talking to that site. The
 * Host header gives the second away, the Origin and Content-Type headers the
 * first.
 *
 * On the NAS the server is on the network and every call needs a session
 * (see auth.ts), so the host check is dropped there. The Origin and JSON
 * checks stay, as a second guard behind the SameSite cookie.
 */

export interface RequestHeaders {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
  'content-type'?: string | string[] | undefined;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The names this server answers to: localhost and 127.0.0.1, on its own port. */
function hostsFor(port: number): Set<string> {
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
}

export interface RefuseOptions {
  /** The server is on the network and every call needs a session (the NAS). */
  signedIn?: boolean;
  /** The request carries the phone's bearer token rather than a cookie. */
  bearer?: boolean;
  /** On the NAS, the names it answers to. Empty or absent means any. */
  hosts?: Set<string>;
}

/**
 * An Origin naming one of the allowed hosts. The PC server only speaks plain
 * http, so there an https Origin is some other site. The NAS is reached over
 * either, depending on whether the proxy is in the way.
 */
function sameSite(origin: string, allowed: Set<string>, httpsToo: boolean): boolean {
  const m = (httpsToo ? /^https?:\/\/(.+)$/ : /^http:\/\/(.+)$/).exec(origin);
  if (!m) return false;
  const name = m[1]!;
  // A browser leaves the default port out of Origin, but Host may carry it.
  return allowed.has(name) || [...allowed].some((h) => h.replace(/:(80|443)$/, '') === name);
}

/**
 * Null when the request may go through, otherwise the reason it was refused.
 * Pure, so it can be tested without starting a server.
 */
export function refuseRequest(
  method: string | undefined,
  headers: RequestHeaders,
  port: number,
  opts: RefuseOptions = {},
): string | null {
  const host = one(headers.host)?.trim().toLowerCase();
  // On the NAS the server answers to its own names when they are known. A
  // rebound name never carries a session, but a server with no owner yet
  // could otherwise be claimed through one.
  const allowed = opts.signedIn
    ? opts.hosts && opts.hosts.size > 0
      ? opts.hosts
      : new Set(host ? [host] : [])
    : hostsFor(port);
  if (!host || !allowed.has(host)) {
    return 'This request did not come from the dashboard on this PC.';
  }

  const verb = (method ?? 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return null;

  // A browser always sends Origin on a cross-site POST. Some tools send none
  // at all, which is fine: they are not a web page acting for someone else.
  // The phone's bearer token cannot be sent by another site, so the phone,
  // whose requests come from its own web view, is not held to this.
  const origin = one(headers.origin)?.trim().toLowerCase();
  if (origin !== undefined && !opts.bearer && !sameSite(origin, allowed, Boolean(opts.signedIn))) {
    return 'This request came from another website, so it was refused.';
  }

  // A cross-site form can only send form or plain text bodies without asking
  // first. Insisting on JSON means a POST from another site has to pass a
  // preflight, which this server never grants.
  if (verb === 'POST') {
    const type = one(headers['content-type'])?.split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') {
      return 'The dashboard sends JSON, and this request did not.';
    }
  }
  return null;
}
