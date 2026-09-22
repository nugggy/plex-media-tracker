import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, DB_PATH, APP_NAME } from './config.ts';
import { handleApi } from './api.ts';
import { isConfigured, getSetting } from './db.ts';
import { runRefresh } from './scanner.ts';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

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

// Bind to loopback only. This is a personal tool, not a network service.
server.listen(PORT, '127.0.0.1', () => {
  const banner = [
    '',
    `  ${APP_NAME}`,
    `  Dashboard   http://localhost:${PORT}`,
    `  Database    ${DB_PATH}`,
    isConfigured()
      ? '  Plex        configured'
      : '  Plex        not configured yet, open Settings in the dashboard',
    '',
  ].join('\n');
  process.stdout.write(`${banner}\n`);

  // Catch up on the watchlist, episodes and library on every start, so the
  // dashboard is current the moment it opens. The slow MusicBrainz scan is
  // deliberately left for the Scan button.
  if (isConfigured() && getSetting('sync_on_start') === '1') {
    process.stdout.write('  Syncing watchlist, episodes and library in the background\n\n');
    void runRefresh();
  }
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
