type Handle = (
  method: string,
  url: URL,
  body: string,
) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

function isApp(url: URL, origin: string): boolean {
  return url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname === '/thumb');
}

/**
 * The dashboard calls /api/... exactly as it does on the PC. Here those calls
 * never leave the app: they go straight to the router. Everything else goes
 * out through Capacitor's native HTTP, with a timer of our own, because the
 * native layer does not promise to honour an AbortSignal.
 */
export function installFetchBridge(
  win: { fetch: typeof fetch; location: { origin: string } },
  handle: Handle,
  opts: { timeoutMs?: number } = {},
): void {
  const real = win.fetch.bind(win);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  win.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href, win.location.origin);
    if (isApp(url, win.location.origin)) {
      const body = typeof init.body === 'string' ? init.body : '';
      const r = await handle((init.method ?? 'GET').toUpperCase(), url, body);
      const bytes = r.body.length ? (r.body as Uint8Array<ArrayBuffer>) : null;
      return new Response(bytes, { status: r.status, headers: r.headers });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`No answer from ${url.host} in ${timeoutMs / 1000} s`);
        e.name = 'TimeoutError';
        reject(e);
      }, timeoutMs);
      // The caller's own AbortSignal.timeout still counts, even if the native
      // layer ignores it.
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
 * <img src="/thumb?..."> is loaded by the web view, not by fetch, so on the
 * phone it would hit the app's own file server and fail. The dashboard's
 * artwork() asks this loader instead, when it is there, and gets back a local
 * object URL. A failure rejects, so artwork() shows its letter placeholder.
 */
export function thumbLoader(fetchFn: typeof fetch): (src: string) => Promise<string> {
  return async (src) => {
    const r = await fetchFn(src);
    if (!r.ok) throw new Error(`Artwork ${r.status}`);
    return URL.createObjectURL(await r.blob());
  };
}
