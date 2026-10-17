import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, DB_PATH, APP_NAME, AUTH_REQUIRED, allowedHosts, isLoopback } from './config.ts';
import { handleApi } from './api.ts';
import { refuseRequest } from './origin.ts';
import { isConfigured } from './db.ts';
import { maybeNightlyScan, startBackgroundSync, SYNC_CHECK_EVERY_MS } from './startup.ts';
import { runDailyBackup } from './backup.ts';
import { handleAuth, isOpenPath, refuseUnsigned, sessionOf, usesBearer } from './authroutes.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const HOSTS = allowedHosts();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Checked here rather than in handleApi, since the tests reach handleApi
  // through route.ts with no headers at all.
  if (url.pathname.startsWith('/api/') || url.pathname === '/thumb') {
    // Marks every answer as this app's, so the phone can tell it apart from
    // something else at the same address, such as the modem's own login page.
    res.setHeader('X-PMT-Server', '1');
    const refused = refuseRequest(req.method, req.headers, PORT, {
      signedIn: AUTH_REQUIRED,
      bearer: usesBearer(req),
      hosts: HOSTS,
    });
    if (refused) {
      res
        .writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: refused }));
      return;
    }
    // On the NAS every call needs a session, apart from the few that sign in.
    // Checked before anything else answers, the sign-in endpoints included.
    if (AUTH_REQUIRED && !isOpenPath(url.pathname) && !sessionOf(req)) {
      refuseUnsigned(res);
      return;
    }
    try {
      if (await handleAuth(req, res, url)) return;
    } catch (err) {
      res
        .writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
  }

  if (await handleApi(req, res, url)) return;

  // Everything else is the single-page dashboard.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);

  // Refuse anything that escaped the public directory.
  if (!filePath.startsWith(PUBLIC_DIR.replace(/[/\\]$/, '') + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
});

// Loopback only on a PC. The NAS container listens on the network, and then
// every call needs a session.
if (!isLoopback(HOST) && !AUTH_REQUIRED) {
  process.stderr.write(
    `\nRefusing to listen on ${HOST} with sign-in turned off: anyone on the network could change settings.\n\n`,
  );
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const banner = [
    '',
    `  ${APP_NAME}`,
    `  Dashboard   http://${isLoopback(HOST) ? 'localhost' : HOST}:${PORT}`,
    `  Sign-in     ${AUTH_REQUIRED ? 'with Plex, owner only' : 'not needed, this machine only'}`,
    `  Database    ${DB_PATH}`,
    isConfigured()
      ? '  Plex        configured'
      : '  Plex        not configured yet, open Settings in the dashboard',
    '',
  ].join('\n');
  process.stdout.write(`${banner}\n`);

  // A copy of the database once a day, before anything else writes to it.
  runDailyBackup();
  if (startBackgroundSync()) {
    process.stdout.write('  Syncing watchlist, episodes and library in the background\n\n');
  }
  // A PC is closed and reopened, so the sync on start keeps it current. The
  // NAS runs for weeks, so it looks again every so often, with the same
  // two-hour gap deciding whether anything is due, and runs the full check
  // overnight.
  setInterval(() => {
    runDailyBackup();
    if (AUTH_REQUIRED && maybeNightlyScan()) return;
    startBackgroundSync();
  }, SYNC_CHECK_EVERY_MS).unref();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\nPort ${PORT} is already in use. Either ${APP_NAME} is already running, or set PLEX_TRACKER_PORT to something else.\n\n`,
    );
    process.exit(1);
  }
  throw err;
});
