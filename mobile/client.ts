/**
 * The phone as a window onto the NAS. Every /api call and every /thumb picture
 * the dashboard asks for goes to the server, with the phone's session as a
 * bearer token, so what is done on the phone happens on the NAS and shows on
 * the desktop page too.
 *
 * Two ways in. The public address (through the modem and the proxy) works
 * anywhere. The home address is a fallback for when the phone is at home and
 * the modem will not loop the public address back inside. Whichever answered
 * last is tried first.
 *
 * When neither answers, a GET is served from the last answer the server gave
 * to the same question, so the lists and pictures are still there to read.
 * Anything that changes something (a POST) cannot be kept for later, and says
 * so instead.
 */

export interface KeyStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface OfflineCache {
  put(key: string, res: Response): Promise<void>;
  match(key: string): Promise<Response | undefined>;
  clear(): Promise<void>;
}

export interface ConnectionStatus {
  offline: boolean;
  /** When the copy being shown was saved, while offline. */
  savedAt: string | null;
}

const SERVER = 'server-url';
const LAN = 'server-lan-url';
const TOKEN = 'session-token';
const ACTIVE = 'server-active';

const SAVED_AT = 'X-PMT-Saved-At';

/** Live progress and sign-in answers are useless an hour later, so they are never kept. */
function cacheable(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  if (path.startsWith('/thumb')) return true;
  if (!path.startsWith('/api/')) return false;
  if (path.startsWith('/api/auth/') || path.startsWith('/api/health')) return false;
  if (path.startsWith('/api/dash/sessions')) return false;
  return !/\/progress(\?|$)/.test(path);
}

/**
 * An address as typed, made into an origin: https assumed when no scheme is
 * given, and any path or trailing slash dropped. Null when it is not one.
 */
export function normaliseServer(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export interface Client {
  serverUrl(): string | null;
  lanUrl(): string | null;
  /** Saves a new server address. Signs out, since a session belongs to one server. */
  setServer(raw: string): string;
  setLanUrl(url: string | null): void;
  hasToken(): boolean;
  setToken(token: string | null): void;
  /** Goes back to trying the public address first, as when the phone may have left home. */
  preferPublic(): void;
  request(method: string, pathAndQuery: string, body: string | null, contentType: string | null): Promise<Response>;
}

export function createClient(opts: {
  fetch: typeof fetch;
  store: KeyStore;
  cache: OfflineCache | null;
  onStatus?: (s: ConnectionStatus) => void;
  now?: () => Date;
}): Client {
  const { store, cache } = opts;
  const now = opts.now ?? (() => new Date());

  const bases = (): string[] => {
    const server = store.get(SERVER);
    if (!server) return [];
    const lan = store.get(LAN);
    const all = lan && lan !== server ? [server, lan] : [server];
    const active = store.get(ACTIVE);
    return active && all.includes(active) ? [active, ...all.filter((b) => b !== active)] : all;
  };

  async function send(base: string, method: string, path: string, body: string | null, type: string | null) {
    const headers: Record<string, string> = {};
    if (type) headers['Content-Type'] = type;
    const token = store.get(TOKEN);
    if (token) headers.Authorization = `Bearer ${token}`;
    return opts.fetch(`${base}${path}`, { method, headers, body: method === 'GET' ? undefined : (body ?? undefined) });
  }

  /**
   * The home address is plain http, so before the token is sent there the
   * server has to prove it holds this session (see proveSession in
   * src/auth.ts). On someone else's network the same address may be a
   * stranger's machine, which cannot answer, and gets nothing. An https
   * address is checked by its certificate instead.
   */
  const proven = new Set<string>();
  async function trusted(base: string): Promise<boolean> {
    const token = store.get(TOKEN);
    if (base.startsWith('https://') || !token) return true;
    const key = `${base}|${token}`;
    if (proven.has(key)) return true;
    try {
      const h = await sha256Hex(token);
      const n = nonce();
      const r = await opts.fetch(`${base}/api/auth/prove?id=${h.slice(0, 16)}&nonce=${n}`, { method: 'GET' });
      if (!r.ok) return false;
      const { proof } = (await r.json()) as { proof?: string };
      if (proof !== (await hmacHex(h, `${n}|${new URL(base).host}`))) return false;
      proven.add(key);
      return true;
    } catch {
      return false;
    }
  }

  async function keep(path: string, res: Response): Promise<void> {
    if (!cache) return;
    try {
      const copy = res.clone();
      const headers = new Headers(copy.headers);
      headers.set(SAVED_AT, now().toISOString());
      await cache.put(path, new Response(await copy.blob(), { status: copy.status, headers }));
    } catch {
      // A full or missing cache only means less to show offline.
    }
  }

  return {
    serverUrl: () => store.get(SERVER),
    lanUrl: () => store.get(LAN),
    setServer(raw) {
      const url = normaliseServer(raw);
      if (!url) throw new Error('That does not look like a web address. It should look like https://music.example.org');
      if (url !== store.get(SERVER)) {
        store.set(SERVER, url);
        store.set(LAN, null);
        store.set(ACTIVE, null);
        store.set(TOKEN, null);
        void cache?.clear();
      }
      return url;
    },
    setLanUrl(url) {
      const clean = url ? normaliseServer(url) : null;
      store.set(LAN, clean);
    },
    hasToken: () => Boolean(store.get(TOKEN)),
    setToken: (token) => store.set(TOKEN, token),
    preferPublic: () => store.set(ACTIVE, null),

    async request(method, path, body, type) {
      const order = bases();
      if (order.length === 0) {
        return jsonResponse(401, { error: 'Choose your server first.', signin: true, setup: true });
      }
      for (const base of order) {
        if (!(await trusted(base))) continue;
        let res: Response;
        try {
          res = await send(base, method, path, body, type);
        } catch (err) {
          // A change that timed out may still have reached the server, so it
          // is not sent again another way, where it could happen twice.
          if (method !== 'GET' && (err as Error).name === 'TimeoutError') {
            return jsonResponse(504, {
              error: 'Your server took too long to answer. The change may still have gone through, so check before trying again.',
            });
          }
          continue; // Not reachable this way. Try the next address.
        }
        if (base !== store.get(ACTIVE)) store.set(ACTIVE, base);
        opts.onStatus?.({ offline: false, savedAt: null });
        if (res.ok && cacheable(method, path)) await keep(path, res);
        return res;
      }

      // Nothing answered.
      if (cacheable(method, path) && cache) {
        const saved = await cache.match(path).catch(() => undefined);
        if (saved) {
          opts.onStatus?.({ offline: true, savedAt: saved.headers.get(SAVED_AT) });
          return saved;
        }
      }
      opts.onStatus?.({ offline: true, savedAt: null });
      return jsonResponse(503, {
        error:
          method === 'GET'
            ? 'Could not reach your server, and there is no saved copy of this yet.'
            : 'Could not reach your server, so nothing was changed. Try again when you are back online.',
        offline: true,
      });
    },
  };
}

/** The Cache Storage API, where the web view has it. Keys become URLs under a made-up host. */
export function browserCache(name = 'pmt-offline-v1'): OfflineCache | null {
  if (typeof caches === 'undefined') return null;
  const url = (key: string) => `https://offline.pmt${key}`;
  return {
    put: async (key, res) => (await caches.open(name)).put(url(key), res),
    match: async (key) => (await caches.open(name)).match(url(key)),
    clear: async () => {
      await caches.delete(name);
    },
  };
}

export function localStore(): KeyStore {
  return {
    get(key) {
      try {
        return localStorage.getItem(`pmt-${key}`);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) localStorage.removeItem(`pmt-${key}`);
        else localStorage.setItem(`pmt-${key}`, value);
      } catch {
        // Nothing to be done without storage; the phone will ask again.
      }
    },
  };
}
