/**
 * Finds a working address for the Plex server, wherever this PC happens to be.
 *
 * With Remote Access on, plex.tv knows every address the server can be reached
 * at: the LAN one, the public one, and the Plex relay. At home the LAN address
 * answers first; away from home it does not, and the public address or the
 * relay takes over. The chosen address is saved as `plex_url`, so everything
 * else keeps reading that one setting and never needs to know which it was.
 */

import * as store from './db.ts';
import { APP_NAME } from './config.ts';
import { PlexUnreachable } from './plex.ts';

export interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexServer {
  machineId: string;
  name: string;
  connections: PlexConnection[];
}

export type ConnectionKind = 'local' | 'remote' | 'relay';

export class ConnectError extends Error {}

/** How long a single address gets to answer before it counts as not there. */
const PROBE_TIMEOUT_MS = 5_000;

export function resourcesUrl(): string {
  return 'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1';
}

interface RawResource {
  name?: string;
  provides?: string;
  clientIdentifier?: string;
  owned?: boolean;
  connections?: { uri?: string; address?: string; port?: number; local?: boolean; relay?: boolean }[];
}

/** 10/8, 172.16/12 and 192.168/16: addresses that never cross the internet. */
function isPrivateIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * With includeHttps=1 plex.tv lists even the LAN address as a plex.direct name,
 * and that name only works if the device's DNS will hand back a home address.
 * Many phones and routers refuse to, as a guard against DNS rebinding, and at
 * home the public address is often no use either, because routers without NAT
 * loopback refuse it from inside. So each private LAN address is also offered
 * bare, over plain http, which needs no DNS at all. The token stays on the
 * home network, and probeIdentity still checks it is the right server.
 */
function withPlainLan(connections: PlexConnection[], raw: NonNullable<RawResource['connections']>): PlexConnection[] {
  const out = [...connections];
  for (const c of raw) {
    if (c.local !== true || c.relay === true || !c.address || !c.port) continue;
    if (!isPrivateIPv4(c.address)) continue;
    const uri = `http://${c.address}:${c.port}`;
    if (!out.some((o) => o.uri === uri)) out.push({ uri, local: true, relay: false });
  }
  return out;
}

/**
 * Servers on the account, from the resources payload. Only owned ones: a
 * server shared by someone else wants its own access token, not the account
 * token this app holds.
 */
export function parseResources(data: unknown): PlexServer[] {
  if (!Array.isArray(data)) return [];
  return (data as RawResource[])
    .filter((r) => r.owned === true && (r.provides ?? '').split(',').includes('server'))
    .filter((r) => r.clientIdentifier)
    .map((r) => ({
      machineId: String(r.clientIdentifier),
      name: r.name ?? 'Plex',
      connections: withPlainLan(
        (r.connections ?? [])
          .filter((c) => c.uri)
          .map((c) => ({ uri: String(c.uri), local: c.local === true, relay: c.relay === true })),
        r.connections ?? [],
      ),
    }));
}

function rank(c: PlexConnection): number {
  const place = c.relay ? 2 : c.local ? 0 : 1;
  const secure = c.uri.startsWith('https://') ? 0 : 1;
  return place * 2 + secure;
}

/**
 * Preference order: LAN, then public, then relay, https before http within
 * each. A non-local address over plain http is dropped outright, because the
 * token rides along on every request and would cross the internet in the clear.
 */
export function orderConnections(connections: PlexConnection[]): PlexConnection[] {
  return connections
    .filter((c) => c.local || c.uri.startsWith('https://'))
    .sort((a, b) => rank(a) - rank(b));
}

export function kindOf(c: PlexConnection): ConnectionKind {
  return c.relay ? 'relay' : c.local ? 'local' : 'remote';
}

/**
 * True when the address answers and it is the server we asked for. A LAN
 * address such as 192.168.1.10 can belong to something else entirely on
 * another network, so the machine id has to match.
 */
export async function probeIdentity(
  uri: string,
  machineId: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${uri.replace(/\/+$/, '')}/identity`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
    return data.MediaContainer?.machineIdentifier === machineId;
  } catch {
    return false;
  }
}

/**
 * Tries every address at once and keeps the most preferred one that answered.
 * One after another would mean waiting out each dead LAN address in turn, and
 * waiting for every probe would mean the answer arriving no sooner than the
 * slowest timeout. So the pick is made the moment the best address has said
 * yes and everything ranked above it has said no.
 */
export function pickConnection(
  ordered: PlexConnection[],
  probe: (c: PlexConnection) => Promise<boolean>,
): Promise<PlexConnection | null> {
  if (ordered.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const answers: (boolean | undefined)[] = new Array(ordered.length).fill(undefined);
    let decided = false;
    const decide = (): void => {
      for (let i = 0; i < ordered.length; i += 1) {
        if (answers[i] === undefined) return; // still waiting on a better one
        if (answers[i]) {
          decided = true;
          resolve(ordered[i]!);
          return;
        }
      }
      decided = true;
      resolve(null);
    };
    ordered.forEach((c, i) => {
      probe(c)
        .catch(() => false)
        .then((answer) => {
          answers[i] = answer;
          if (!decided) decide();
        });
    });
  });
}

export async function listServers(token: string): Promise<PlexServer[]> {
  let res: Response;
  try {
    res = await fetch(resourcesUrl(), {
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': token,
        'X-Plex-Product': APP_NAME,
        'X-Plex-Client-Identifier': 'plex-media-tracker',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ConnectError('Could not reach plex.tv to look up your server. Check your internet connection.');
  }
  if (res.status === 401) throw new ConnectError('plex.tv rejected the token.');
  if (!res.ok) throw new ConnectError(`plex.tv returned HTTP ${res.status}`);
  return parseResources(await res.json());
}

export interface Resolved {
  url: string;
  kind: ConnectionKind;
  serverName: string;
}

/** Looks the server up on plex.tv and returns the best address that answers. */
export async function resolveServer(token: string, machineId: string): Promise<Resolved> {
  const servers = await listServers(token);
  const server = servers.find((s) => s.machineId === machineId);
  if (!server) {
    throw new ConnectError(
      'That server is no longer on your Plex account. Pick it again in Settings.',
    );
  }
  const picked = await pickConnection(orderConnections(server.connections), (c) =>
    probeIdentity(c.uri, machineId),
  );
  if (!picked) {
    throw new ConnectError(
      `${server.name} did not answer at any of its addresses. Check the server is switched on and that Remote Access in Plex says it is fully accessible outside your network.`,
    );
  }
  return { url: picked.uri, kind: kindOf(picked), serverName: server.name };
}

/* ------------------------------------------------------ settings glue */

function isAuto(): boolean {
  return store.getSetting('plex_connection') === 'auto' && Boolean(store.getSetting('plex_machine_id'));
}

/**
 * In automatic mode, works the address out again and saves it. Returns a note
 * for the progress strip when the relay is in use, since that is slow. In
 * manual mode it does nothing and the saved address stands.
 */
export async function ensurePlexUrl(): Promise<string | null> {
  if (!isAuto()) return null;
  const found = await resolveServer(store.getSetting('plex_token'), store.getSetting('plex_machine_id'));
  store.setSetting('plex_url', found.url);
  store.setSetting('plex_connection_kind', found.kind);
  return found.kind === 'relay'
    ? 'Reaching Plex through the Plex relay, which is slow. Reading the library will take longer than usual.'
    : null;
}

/**
 * Runs a block of Plex work. If nothing answers partway through, as when a
 * laptop leaves home mid-check, it looks the address up once more and has one
 * more go, but only when the lookup actually found a different address.
 */
export async function retryOnUnreachable<T>(
  work: (url: string) => Promise<T>,
  currentUrl: () => string,
  reresolve: () => Promise<unknown>,
): Promise<T> {
  const before = currentUrl();
  try {
    return await work(before);
  } catch (err) {
    if (!(err instanceof PlexUnreachable)) throw err;
    await reresolve();
    const after = currentUrl();
    if (after === before) throw err;
    return work(after);
  }
}

/** `retryOnUnreachable` against the saved settings. Manual mode never retries. */
export async function withPlex<T>(work: (url: string) => Promise<T>): Promise<T> {
  if (!isAuto()) return work(store.getSetting('plex_url'));
  return retryOnUnreachable(work, () => store.getSetting('plex_url'), ensurePlexUrl);
}
