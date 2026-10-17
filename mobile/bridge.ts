type Handle = (method: string, url: URL, body: string | null, contentType: string | null) => Promise<Response>;

function isApp(url: URL, origin: string): boolean {
  return url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname === '/thumb');
}

/**
 * A fetch with a timer of its own, because Capacitor's native HTTP does not
 * promise to honour an AbortSignal. The caller's own signal still counts.
 */
export function withTimeout(real: typeof fetch, timeoutMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const host = (() => {
      try {
        return new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).host;
      } catch {
        return 'the server';
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`No answer from ${host} in ${timeoutMs / 1000} s`);
        e.name = 'TimeoutError';
        reject(e);
      }, timeoutMs);
      const signal = init.signal;
      if (signal) {
        onAbort = () => reject(signal.reason ?? new Error('Aborted'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([real(input, init), giveUp]);
    } finally {
      clearTimeout(timer);
      if (onAbort) init.signal?.removeEventListener('abort', onAbort);
    }
  }) as typeof fetch;
}

/**
 * The dashboard calls /api/... exactly as it does on the PC. On the phone
 * those calls are handed to `handle`, which sends them on to the NAS.
 * Everything else (the update check on GitHub) goes out through Capacitor's
 * native HTTP, with the timer above.
 */
export function installFetchBridge(
  win: { fetch: typeof fetch; location: { origin: string } },
  handle: Handle,
  opts: { timeoutMs?: number } = {},
): void {
  const outside = withTimeout(win.fetch.bind(win), opts.timeoutMs ?? 60_000);

  win.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href, win.location.origin);
    if (isApp(url, win.location.origin)) {
      const body = typeof init.body === 'string' ? init.body : null;
      const type = new Headers(init.headers).get('Content-Type');
      return handle((init.method ?? 'GET').toUpperCase(), url, body, type);
    }
    return outside(input, init);
  }) as typeof fetch;
}

/**
 * <img src="/thumb?..."> is loaded by the web view, not by fetch, so on the
 * phone it would hit the app's own file server and fail. The dashboard's
 * artwork() asks this loader instead, when it is there, and gets back a local
 * object URL. A failure rejects, so artwork() shows its letter placeholder.
 */
export function thumbLoader(fetchFn: typeof fetch): (src: string) => Promise<string> {
  // One fetch per picture for the life of the app. Lists redraw on every
  // keystroke in a filter, and each fetch may cross mobile data to Plex.
  const cache = new Map<string, Promise<string>>();
  return (src) => {
    const hit = cache.get(src);
    if (hit) return hit;
    const p = (async () => {
      const r = await fetchFn(src);
      if (!r.ok) throw new Error(`Artwork ${r.status}`);
      return URL.createObjectURL(await r.blob());
    })();
    cache.set(src, p);
    // A failure is not remembered, so the next redraw can try again.
    p.catch(() => cache.delete(src));
    return p;
  };
}
