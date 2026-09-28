import type { IncomingMessage, ServerResponse } from 'node:http';
import * as store from './db.ts';
import { PLATFORM } from './config.ts';
import { APP_VERSION, RELEASES_URL } from './version.ts';
import * as wl from './watchlist-db.ts';
import { getProgress, requestStop, runScan, runRefresh } from './scanner.ts';
import { testConnection, thumbUrl } from './plex.ts';
import { ensurePlexUrl, listServers, resolveServer } from './plexconnect.ts';
import { posterUrl, verifyAccount } from './plexdiscover.ts';
import { removeItem, restoreItem, type RefreshPart } from './watchlist.ts';
import { isMbid } from './matching.ts';
import { resolve as resolveYoutube, clearCache as clearYoutubeCache } from './youtube.ts';
import { buildSuggestions, listSuggestions, hideSuggestion } from './suggestions.ts';
import { listTrending, buildTrending, hideTrending, builtAt } from './trending.ts';
import { sydneyDate } from './dates.ts';
import { episodeFeed, dismissEpisode } from './episodes.ts';
import { libraryReport, deepLink } from './library.ts';
import {
  search,
  addFilmOrShow,
  trackArtist,
  untrackArtist,
  searchThumbUrl,
  isSearchThumbHost,
} from './search.ts';
import { getDetails } from './details.ts';
import { nowPlaying, stopStream, libraryStats, recentlyAdded, history, isPlexArtPath, resizedArtPath } from './dash.ts';

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Plain bytes rather than Node buffers, so this also runs in the phone's web view.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Uint8Array).length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Uint8Array);
  }
  if (chunks.length === 0) return {};
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all)) as Record<string, unknown>;
  } catch {
    throw new Error('Request body was not valid JSON');
  }
}

const SETTABLE = new Set([
  'plex_url',
  'plex_token',
  'plex_connection',
  'plex_machine_id',
  'plex_section',
  'plex_section_title',
  'recent_days',
  'stale_days',
  'include_album',
  'include_ep',
  'include_single',
  'include_movie',
  'include_show',
  'watchlist_enabled',
  'sync_on_start',
  'tmdb_api_key',
]);

/* ------------------------------------------------------------ unified feed */

export interface FeedItem {
  source: 'music' | 'watchlist' | 'episode';
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  date: string | null;
  /**
   * The exact instant an episode lands, when one is known. Only episodes carry
   * it: a record or a film has a release date and no meaningful release time.
   */
  air_stamp?: string | null;
  event: string | null;
  thumb: string | null;
  link: string | null;
  first_seen_at: string;
  dismissed: number;
  date_kind?: string | null;
  group?: string | null;
  /** 1 when this exact thing is already on the Plex server. */
  in_library: number;
  /** Opens the thing in the Plex app, when it is on the server. */
  plex_link?: string | null;
}

/** Music releases and watchlist items, in one shape the page can render alike. */
function buildFeed(kind: 'out' | 'upcoming' | 'dismissed', recentDays: number): FeedItem[] {
  const items: FeedItem[] = [];

  for (const r of store.feed(kind, recentDays)) {
    items.push({
      source: 'music',
      kind: (r.primary_type ?? 'album').toLowerCase(),
      id: r.mb_id,
      title: r.title,
      subtitle: r.artist_name,
      date: r.release_date,
      event: null,
      thumb: `/thumb?key=${encodeURIComponent(r.plex_key)}`,
      link: `https://musicbrainz.org/release-group/${r.mb_id}`,
      plex_link: deepLink(r.plex_key),
      first_seen_at: r.first_seen_at,
      dismissed: r.dismissed,
      in_library: r.owned,
    });
  }

  if (store.getSetting('watchlist_enabled') === '1') {
    for (const e of episodeFeed(kind, recentDays)) {
      items.push({
        source: 'episode',
        kind: 'show',
        id: e.id,
        title: e.title,
        subtitle: e.subtitle,
        date: e.date,
        air_stamp: e.air_stamp,
        event: e.event,
        thumb: `/thumb?wl=${encodeURIComponent(e.show_key)}`,
        link: null,
        first_seen_at: e.first_seen_at,
        dismissed: e.dismissed,
        group: e.show_key,
        in_library: e.in_library,
        plex_link: e.plex_rating_key ? deepLink(e.plex_rating_key) : null,
      });
    }
    for (const w of wl.watchlistFeed(kind, recentDays)) {
      items.push({
        source: 'watchlist',
        kind: w.kind,
        id: w.id,
        title: w.title,
        subtitle: w.subtitle,
        date: w.date,
        event: w.event,
        thumb: `/thumb?wl=${encodeURIComponent(w.id)}`,
        link: w.public_url,
        first_seen_at: w.first_seen_at,
        dismissed: w.dismissed,
        date_kind: w.date_kind,
        in_library: w.in_library,
        plex_link: w.plex_rating_key ? deepLink(w.plex_rating_key) : null,
      });
    }
  }
  return items;
}

/* ------------------------------------------------------------------ routes */

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/') && path !== '/thumb') return false;

  try {
    if (path === '/thumb') {
      await proxyThumb(
        res,
        url.searchParams.get('key'),
        url.searchParams.get('wl'),
        url.searchParams.get('t'),
        url.searchParams.get('url'),
        url.searchParams.get('px'),
      );
      return true;
    }

    if (path === '/api/state' && req.method === 'GET') {
      const settings = store.getSettings();
      const recentDays = Number(settings.recent_days) || 180;
      const watchlistOn = settings.watchlist_enabled === '1';
      const music = store.counts(recentDays);
      const watch = watchlistOn ? wl.watchlistCounts(recentDays) : { out: 0, upcoming: 0, listed: 0 };
      // Episodes are part of the feeds, so the badges have to count them too.
      const eps = watchlistOn
        ? {
            out: episodeFeed('out', recentDays).filter((e) => e.in_library !== 1).length,
            upcoming: episodeFeed('upcoming', recentDays).length,
          }
        : { out: 0, upcoming: 0 };
      send(res, 200, {
        configured: store.isConfigured(),
        watchlist_enabled: watchlistOn,
        machine_id: store.getSetting('plex_machine_id') || null,
        counts: {
          out: music.out + watch.out + eps.out,
          upcoming: music.upcoming + watch.upcoming + eps.upcoming,
          artists: music.artists,
          unresolved: music.unresolved,
          watchlist: watch.listed,
        },
        progress: getProgress(),
        scans: store.recentScans(),
      });
      return true;
    }

    if (path === '/api/releases' && req.method === 'GET') {
      const raw = url.searchParams.get('view') ?? 'out';
      const kind: 'out' | 'upcoming' | 'dismissed' =
        raw === 'upcoming' ? 'upcoming' : raw === 'dismissed' ? 'dismissed' : 'out';
      const recentDays = Number(store.getSetting('recent_days')) || 180;
      send(res, 200, { releases: buildFeed(kind, recentDays) });
      return true;
    }

    if (path === '/api/releases/dismiss' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id ?? body.mb_id ?? '');
      const source = String(body.source ?? 'music');
      if (!id) return bad(res, 'id is required');
      const dismissed = body.dismissed !== false;
      if (source === 'episode') dismissEpisode(id, dismissed);
      else if (source === 'watchlist') wl.dismissWatchlistItem(id, dismissed);
      else store.dismissRelease(id, dismissed);
      send(res, 200, { ok: true });
      return true;
    }

    /* ----------------------------------------------------------- artists */
    if (path === '/api/artists' && req.method === 'GET') {
      send(res, 200, {
        artists: store.allArtists().map((a) => ({
          ...a,
          mb_candidates: a.mb_candidates ? (JSON.parse(a.mb_candidates) as unknown) : null,
        })),
      });
      return true;
    }

    if (path === '/api/artists/mute' && req.method === 'POST') {
      const body = await readJson(req);
      const key = String(body.plex_key ?? '');
      if (!key) return bad(res, 'plex_key is required');
      store.setArtistMuted(key, body.muted !== false);
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/artists/mbid' && req.method === 'POST') {
      const body = await readJson(req);
      const key = String(body.plex_key ?? '');
      const mbid = String(body.mbid ?? '').trim();
      if (!key) return bad(res, 'plex_key is required');
      if (mbid && !isMbid(mbid)) return bad(res, 'That does not look like a MusicBrainz artist ID.');
      store.setArtistMbid(key, mbid || null, mbid ? 'manual' : 'pending');
      send(res, 200, { ok: true });
      return true;
    }

    /* --------------------------------------------------------- watchlist */
    if (path === '/api/watchlist' && req.method === 'GET') {
      send(res, 200, {
        items: wl.allWatchlistRows().map((r) => ({
          ...r,
          thumb_url: `/thumb?wl=${encodeURIComponent(r.rating_key)}`,
        })),
        removals: wl.recentRemovals(),
      });
      return true;
    }

    if (path === '/api/watchlist/gaps' && req.method === 'GET') {
      send(res, 200, { shows: wl.libraryShowGaps() });
      return true;
    }

    if (path === '/api/watchlist/remove' && req.method === 'POST') {
      const body = await readJson(req);
      const key = String(body.rating_key ?? '');
      if (!key) return bad(res, 'rating_key is required');
      await removeItem(key);
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/watchlist/restore' && req.method === 'POST') {
      const body = await readJson(req);
      const key = String(body.rating_key ?? '');
      if (!key) return bad(res, 'rating_key is required');
      await restoreItem(key);
      send(res, 200, { ok: true });
      return true;
    }

    /**
     * Each tab asks for only what it shows. Measured on a real library:
     * holdings and watchlist are seconds, schedules is the slow one.
     */
    if (path === '/api/refresh' && req.method === 'POST') {
      if (getProgress().running) {
        return bad(res, 'Something is already running. Wait for it to finish.');
      }
      const body = await readJson(req);
      const job = String(body.job ?? 'all');
      const JOBS: Record<string, RefreshPart[]> = {
        releases: ['holdings'],
        watchlist: ['watchlist', 'holdings'],
        library: ['holdings'],
        schedules: ['schedules'],
        filmdates: ['filmdates'],
        all: ['holdings', 'watchlist', 'schedules', 'filmdates'],
      };
      // The Artists tab wants MusicBrainz, which lives in the scan, not here.
      if (job === 'music') {
        void runScan(true);
        send(res, 202, { started: true, job });
        return true;
      }
      const parts = JOBS[job];
      if (!parts) return bad(res, `Unknown refresh job: ${job}`);
      void runRefresh(parts);
      send(res, 202, { started: true, job });
      return true;
    }

    if (path === '/api/watchlist/sync' && req.method === 'POST') {
      if (getProgress().running) {
        return bad(res, 'Something is already running. Wait for it to finish.');
      }
      // Not awaited: a refresh takes minutes, so the page polls /api/state.
      void runRefresh();
      send(res, 202, { started: true });
      return true;
    }

    if (path === '/api/watchlist/test' && req.method === 'POST') {
      const token = store.getSetting('plex_token');
      if (!token) return bad(res, 'Save your Plex token first.');
      try {
        const account = await verifyAccount(token);
        send(res, 200, { ok: true, message: `Signed in as ${account}.` });
      } catch (err) {
        send(res, 200, { ok: false, message: (err as Error).message });
      }
      return true;
    }

    if (path === '/api/library' && req.method === 'GET') {
      send(res, 200, libraryReport());
      return true;
    }

    /* --------------------------------------------------------- dashboard */
    if (path === '/api/dash/sessions' && req.method === 'GET') {
      const now = await nowPlaying();
      send(res, 200, {
        ...now,
        streams: now.streams.map((s) => ({ ...s, thumb: s.thumb ? `/thumb?px=${encodeURIComponent(s.thumb)}` : null })),
      });
      return true;
    }

    if (path === '/api/dash/stop' && req.method === 'POST') {
      const body = await readJson(req);
      const sessionId = String(body.session_id ?? '');
      if (!sessionId) return bad(res, 'session_id is required');
      const reason = String(body.reason ?? '').trim() || 'The server owner stopped this stream.';
      await stopStream(sessionId, reason.slice(0, 200));
      send(res, 200, { ok: true });
      return true;
    }

    if (path === '/api/dash/library' && req.method === 'GET') {
      const [stats, added] = await Promise.all([libraryStats(), recentlyAdded()]);
      send(res, 200, {
        libraries: stats,
        added: added.map((a) => ({ ...a, thumb: a.thumb ? `/thumb?px=${encodeURIComponent(a.thumb)}` : null })),
      });
      return true;
    }

    if (path === '/api/dash/history' && req.method === 'GET') {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
      const h = await history(days);
      send(res, 200, {
        ...h,
        recent: h.recent.map((p) => ({ ...p, thumb: p.thumb ? `/thumb?px=${encodeURIComponent(p.thumb)}` : null })),
      });
      return true;
    }

    /* ----------------------------------------------------------- search */
    if (path === '/api/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const raw = url.searchParams.get('kinds');
      const kinds = new Set(raw ? raw.split(',').filter(Boolean) : ['movie', 'show', 'artist']);
      send(res, 200, await search(q, kinds));
      return true;
    }

    if (path === '/api/search/add' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind ?? '');
      const id = String(body.id ?? '');
      if (!id) return bad(res, 'id is required');

      if (kind === 'artist') {
        const name = String(body.title ?? '').trim();
        if (!name) return bad(res, 'title is required for an artist');
        trackArtist(id, name);
        send(res, 200, {
          ok: true,
          message: `Now watching ${name}. Their records appear after the next check.`,
        });
        return true;
      }
      await addFilmOrShow(id);
      send(res, 200, {
        ok: true,
        message: `Added to your Plex watchlist. It appears here after the next check.`,
      });
      return true;
    }

    if (path === '/api/search/details' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      const kind = url.searchParams.get('kind') ?? 'movie';
      if (!id) return bad(res, 'id is required');
      if (kind !== 'movie' && kind !== 'show') {
        return bad(res, 'Details are only available for films and shows.');
      }
      send(res, 200, await getDetails(kind, id));
      return true;
    }

    if (path === '/api/search/untrack' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id ?? '');
      if (!id) return bad(res, 'id is required');
      untrackArtist(id);
      send(res, 200, { ok: true });
      return true;
    }

    /* ---------------------------------------------------------- youtube */
    if (path === '/api/youtube' && req.method === 'GET') {
      send(
        res,
        200,
        await resolveYoutube({
          kind: url.searchParams.get('kind') ?? 'album',
          title: url.searchParams.get('title') ?? '',
          artist: url.searchParams.get('subtitle') ?? '',
        }),
      );
      return true;
    }

    if (path === '/api/youtube/clear' && req.method === 'POST') {
      send(res, 200, { ok: true, cleared: clearYoutubeCache() });
      return true;
    }

    /* ------------------------------------------------------- suggestions */
    if (path === '/api/suggestions' && req.method === 'GET') {
      send(res, 200, { suggestions: listSuggestions() });
      return true;
    }

    if (path === '/api/suggestions/build' && req.method === 'POST') {
      if (suggestionsRunning) return bad(res, 'Suggestions are already being built.');
      const body = await readJson(req);
      const what = body.what === 'music' || body.what === 'video' ? body.what : 'all';
      suggestionsRunning = true;
      suggestionsProgress = 'Starting';
      void buildSuggestions(what, (m) => {
        suggestionsProgress = m;
      })
        .then((r) => {
          suggestionsProgress = r.message;
        })
        .catch((e: Error) => {
          suggestionsProgress = `Failed: ${e.message}`;
        })
        .finally(() => {
          suggestionsRunning = false;
        });
      send(res, 202, { started: true });
      return true;
    }

    if (path === '/api/suggestions/progress' && req.method === 'GET') {
      send(res, 200, { running: suggestionsRunning, message: suggestionsProgress });
      return true;
    }

    if (path === '/api/suggestions/hide' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind ?? '');
      const id = String(body.id ?? '');
      if (!kind || !id) return bad(res, 'kind and id are required');
      hideSuggestion(kind, id, body.hidden !== false);
      send(res, 200, { ok: true });
      return true;
    }

    /* ---------------------------------------------------------- trending */
    if (path === '/api/trending' && req.method === 'GET') {
      // Converted to a Sydney calendar date here, once, rather than in the
      // page: the stored timestamp is UTC, and the tab needs the day it
      // reads as in Sydney, not the day it happens to fall on in UTC.
      const at = builtAt();
      const builtDates = Object.fromEntries(
        Object.entries(at).map(([kind, iso]) => [kind, iso ? sydneyDate(iso) : null]),
      );
      send(res, 200, {
        items: listTrending(),
        built_at: builtDates,
        has_tmdb_key: store.getSetting('tmdb_api_key').trim() !== '',
      });
      return true;
    }

    if (path === '/api/trending/build' && req.method === 'POST') {
      if (trendingRunning) return bad(res, 'Trending is already being built.');
      trendingRunning = true;
      trendingProgress = 'Starting';
      // Not awaited: a build takes minutes, dominated by MusicBrainz at one
      // request a second, so the page polls /api/trending/progress instead.
      void buildTrending((m) => {
        trendingProgress = m;
      })
        .then((r) => {
          trendingProgress = r.message;
        })
        .catch((e: Error) => {
          // Caught here so a failed build cannot become an unhandled
          // rejection; the outer try/catch in this function never sees it,
          // since nothing awaits this promise.
          trendingProgress = `Failed: ${e.message}`;
        })
        .finally(() => {
          trendingRunning = false;
        });
      send(res, 202, { started: true });
      return true;
    }

    if (path === '/api/trending/progress' && req.method === 'GET') {
      // Polled every second or so, so this must stay cheap: no database work,
      // just the two module-level variables the build above keeps updated.
      send(res, 200, { running: trendingRunning, message: trendingProgress });
      return true;
    }

    if (path === '/api/trending/hide' && req.method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind ?? '');
      const id = String(body.id ?? '');
      if (!kind || !id) return bad(res, 'kind and id are required');
      hideTrending(kind, id, body.hidden !== false);
      send(res, 200, { ok: true });
      return true;
    }

    /* ---------------------------------------------------------- settings */
    if (path === '/api/settings' && req.method === 'GET') {
      const settings = store.getSettings();
      send(res, 200, {
        settings: {
          ...settings,
          plex_token: settings.plex_token ? '********' : '',
          tmdb_api_key: settings.tmdb_api_key ? '********' : '',
        },
        token_set: Boolean(settings.plex_token),
        platform: PLATFORM,
        version: APP_VERSION,
        releases_url: RELEASES_URL,
      });
      return true;
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const body = await readJson(req);
      for (const [key, value] of Object.entries(body)) {
        if (!SETTABLE.has(key)) continue;
        if ((key === 'plex_token' || key === 'tmdb_api_key') && value === '********') continue;
        store.setSetting(key, String(value));
      }
      // Automatic mode has no typed address, so find one now. If the server
      // cannot be reached this minute, the next check tries again.
      let warning: string | null = null;
      if (store.getSetting('plex_connection') === 'auto') {
        try {
          await ensurePlexUrl();
        } catch (err) {
          // Saved regardless. Each check looks the server up again.
          warning = `Saved, but the server could not be reached just now: ${(err as Error).message}`;
        }
      }
      send(res, 200, { ok: true, configured: store.isConfigured(), warning });
      return true;
    }

    if (path === '/api/plex/servers' && req.method === 'POST') {
      const body = await readJson(req);
      const token = tokenFrom(body);
      if (!token) return bad(res, 'Enter your Plex token first.');
      try {
        const servers = await listServers(token);
        send(res, 200, { servers: servers.map((s) => ({ machine_id: s.machineId, name: s.name })) });
      } catch (err) {
        return bad(res, (err as Error).message);
      }
      return true;
    }

    if (path === '/api/plex/test' && req.method === 'POST') {
      const body = await readJson(req);
      const token = tokenFrom(body);
      if (body.plex_connection === 'auto') {
        const machineId = String(body.plex_machine_id ?? '');
        if (!machineId || !token) return bad(res, 'Pick a server and enter a token first.');
        let found;
        try {
          found = await resolveServer(token, machineId);
        } catch (err) {
          send(res, 200, { ok: false, message: (err as Error).message, sections: [] });
          return true;
        }
        const result = await testConnection(found.url, token);
        const how = {
          local: 'on your home network',
          remote: 'over the internet',
          relay: 'through the Plex relay, which is slow',
        }[found.kind];
        send(res, 200, {
          ...result,
          message: result.ok ? `${result.message} Reached ${how}.` : result.message,
          plex_url: found.url,
          kind: found.kind,
        });
        return true;
      }
      const plexUrl = String(body.plex_url ?? store.getSetting('plex_url'));
      if (!plexUrl || !token) return bad(res, 'Both a server URL and a token are needed.');
      send(res, 200, await testConnection(plexUrl, token));
      return true;
    }

    /* -------------------------------------------------------------- scan */
    if (path === '/api/scan/start' && req.method === 'POST') {
      if (getProgress().running) {
        send(res, 200, { started: false, progress: getProgress() });
        return true;
      }
      void runScan();
      send(res, 202, { started: true });
      return true;
    }

    if (path === '/api/scan/stop' && req.method === 'POST') {
      requestStop();
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 404, { error: 'No such endpoint' });
    return true;
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
    return true;
  }
}

let suggestionsRunning = false;
let suggestionsProgress = '';

let trendingRunning = false;
let trendingProgress = '';

/** The token from a settings form, or the saved one when the form holds the mask. */
function tokenFrom(body: Record<string, unknown>): string {
  const raw = String(body.plex_token ?? '');
  return !raw || raw === '********' ? store.getSetting('plex_token') : raw;
}

function bad(res: ServerResponse, message: string): boolean {
  send(res, 400, { error: message });
  return true;
}

/**
 * Chart artwork carries no token, so it needs no proxying to keep a secret. It
 * is proxied anyway so the page never talks to third parties, and the host list
 * is what stops that proxy being a way to reach anything on this network.
 *
 * Wikimedia is here for the artist photographs on the Suggestions tab, and it
 * takes three hosts rather than one because a photo is fetched in three hops:
 * asked for by file name at commons.wikimedia.org, redirected once within
 * Commons, then redirected again to the file itself, which is served from
 * thumb.wikimedia.org when a width is requested and upload.wikimedia.org when
 * it is not. Only those subdomains are listed, so the proxy cannot be pointed
 * at Wikipedia or Wikidata articles.
 */
const THUMB_HOSTS =
  /^(is[1-5]-ssl\.mzstatic\.com|image\.tmdb\.org|(commons|upload|thumb)\.wikimedia\.org)$/;

export function allowedThumbHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    // A non-default port buys an attacker nothing on these fixed hostnames,
    // but refusing it keeps the allowlist to exactly what chart artwork needs.
    if (parsed.protocol !== 'https:' || parsed.port !== '') return false;
    return THUMB_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

const MAX_THUMB_REDIRECTS = 3;

/**
 * A redirect can point anywhere, including off the allowlist, so trusting the
 * first check and then following the Location header unchecked would reopen
 * the exact hole the allowlist exists to close. The Location is resolved
 * against the URL that sent it, since a redirect is often relative, and only
 * handed back once it has passed the same check the original URL did. Which
 * check that is depends on where the target came from, since chart artwork
 * and a Discover search thumb are allowed onto different hosts.
 */
export function resolveThumbRedirect(
  location: string,
  from: string,
  isAllowed: (url: string) => boolean = allowedThumbHost,
): string | null {
  try {
    const next = new URL(location, from).toString();
    return isAllowed(next) ? next : null;
  } catch {
    return null;
  }
}

/**
 * Follows redirects by hand, rather than letting fetch do it, so every hop
 * off an allowlisted URL is re-checked rather than only the first one. CDNs
 * do redirect in normal operation, so a 3xx is not itself a failure; running
 * out of hops, a missing Location, or a hop that fails `isAllowed` all end
 * the same way, as a dead end.
 */
async function fetchWithCheckedRedirects(
  url: string,
  isAllowed: (url: string) => boolean,
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const upstream = await fetch(current, {
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    if (upstream.status < 300 || upstream.status >= 400) return upstream;
    if (hop >= MAX_THUMB_REDIRECTS) return null;
    const location = upstream.headers.get('location');
    const next = location ? resolveThumbRedirect(location, current, isAllowed) : null;
    if (!next) return null;
    current = next;
  }
}

/**
 * Artwork is fetched server side so the Plex token never reaches the page.
 * Artist images come from the local server, posters from plex.tv, and chart
 * artwork comes straight from Apple or TMDB behind the allowlist above.
 */
async function proxyThumb(
  res: ServerResponse,
  plexKey: string | null,
  watchlistKey: string | null,
  searchThumb: string | null = null,
  directUrl: string | null = null,
  plexArt: string | null = null,
): Promise<void> {
  const token = store.getSetting('plex_token');
  let target: string | null = null;
  // Chart artwork and a Discover search thumb both arrive as free text on
  // the query string, so both are gated by a host check, and both need every
  // redirect hop re-checked against it, not just the URL the page supplied.
  // watchlistKey and plexKey only ever select an already-known DB row, so
  // their target is server-built, not page-supplied text.
  let isAllowed: ((url: string) => boolean) | null = null;

  if (plexArt) {
    // Checked against a fixed shape, and aimed only at the saved server.
    target = isPlexArtPath(plexArt) ? thumbUrl(store.getSetting('plex_url'), token, resizedArtPath(plexArt)) : null;
  } else if (directUrl) {
    target = allowedThumbHost(directUrl) ? directUrl : null;
    isAllowed = allowedThumbHost;
  } else if (searchThumb) {
    target = searchThumbUrl(searchThumb);
    isAllowed = isSearchThumbHost;
  } else if (watchlistKey) {
    const row = wl.getWatchlistRow(watchlistKey);
    target = row ? posterUrl(token, row.thumb) : null;
  } else if (plexKey) {
    const artist = store.getArtist(plexKey);
    target = artist ? thumbUrl(store.getSetting('plex_url'), token, artist.thumb) : null;
  }

  if (!target) {
    res.writeHead(404).end();
    return;
  }
  try {
    const upstream = isAllowed
      ? await fetchWithCheckedRedirects(target, isAllowed)
      : await fetch(target, { signal: AbortSignal.timeout(15_000) });
    if (!upstream || !upstream.ok) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(new Uint8Array(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(404).end();
  }
}
