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
 * first. The phone has no server and comes in through route.ts, so none of
 * this applies there, which is why it lives here and not in handleApi.
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

/**
 * Null when the request may go through, otherwise the reason it was refused.
 * Pure, so it can be tested without starting a server.
 */
export function refuseRequest(
  method: string | undefined,
  headers: RequestHeaders,
  port: number,
): string | null {
  const allowed = hostsFor(port);
  const host = one(headers.host)?.trim().toLowerCase();
  if (!host || !allowed.has(host)) {
    return 'This request did not come from the dashboard on this PC.';
  }

  const verb = (method ?? 'GET').toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return null;

  // A browser always sends Origin on a cross-site POST. Some tools send none
  // at all, which is fine: they are not a web page acting for someone else.
  const origin = one(headers.origin)?.trim().toLowerCase();
  if (origin !== undefined && !(origin.startsWith('http://') && allowed.has(origin.slice(7)))) {
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
