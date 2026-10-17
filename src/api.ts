import type { IncomingMessage, ServerResponse } from 'node:http';
import * as store from './db.ts';
import { AUTH_REQUIRED, restartNeeded } from './config.ts';
import { APP_VERSION, RELEASES_URL } from './version.ts';
import * as wl from './watchlist-db.ts';
import { getProgress, requestStop, runScan, runRefresh } from './scanner.ts';
import { testConnection, thumbUrl, fetchTracks } from './plex.ts';
import { ensurePlexUrl, listServers, resolveServer, withPlex } from './plexconnect.ts';
import {
  communityGql,
  cachedFriends,
  cachedWatchlist,
  clearFriendCache,
  flagItems,
  mergeAcrossFriends,
} from './friends.ts';
import {
  trackStates,
  fetchLyrics,
  lyricsProgress,
  getLyric,
  saveLyric,
  lyricCounts,
  type Track,
} from './lyrics.ts';
import { posterUrl, verifyAccount } from './plexdiscover.ts';
import { exportLyrics } from './lyricexport.ts';
import { createJob, runInBackground } from './jobs.ts';
import { removeItem, restoreItem, type RefreshPart } from './watchlist.ts';
import { isMbid } from './matching.ts';
import { resolve as resolveYoutube, clearCache as clearYoutubeCache } from './youtube.ts';
import { buildSuggestions, listSuggestions, hideSuggestion } from './suggestions.ts';
import { listTrending, buildTrending, hideTrending, builtAt } from './trending.ts';
import { trendingJob, maybeAutoBuildTrending, trendingIsStale } from './trendingauto.ts';
import { sydneyDate, today, shiftDate } from './dates.ts';
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
import {
  nowPlaying,
  stopStream,
  libraryStats,
  recentlyAdded,
  history,
  isPlexArtPath,
  resizedArtPath,
  cachedTrackCount,
  rememberTrackCount,
  refreshTrackCount,
} from './dash.ts';

/**
 * A key on the home Plex server is a plain number. Anything a request hands
 * in that ends up in a Plex URL path is checked against this first, so a key
 * can never carry a slash, a dot-dot or a query string with it.
 */
export function isPlexKey(value: string): boolean {
  return /^\d+$/.test(value);
}

/** A Discover (plex.tv) rating key: letters and digits only, usually 24 hex characters. */
export function isDiscoverKey(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value);
}

/** Tracks as the page sends them back, with anything malformed dropped. */
function trackList(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  const out: Track[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (!t || typeof t !== 'object' || !t.rating_key || !t.title || !t.artist) continue;
    // Stored lyrics are later looked up on the server by this key.
    if (!isPlexKey(String(t.rating_key))) continue;
    out.push({
      rating_key: String(t.rating_key),
      title: String(t.title),
      artist: String(t.artist),
      album: t.album ? String(t.album) : null,
      duration_ms: typeof t.duration_ms === 'number' ? t.duration_ms : null,
      covered: t.covered === true,
    });
  }
  return out;
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
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
  'include_movie',
  'include_show',
  'watchlist_enabled',
  'sync_on_start',
  'tmdb_api_key',
]);

/** The settings that decide how the Plex server is reached. */
const CONNECTION_KEYS = ['plex_url', 'plex_token', 'plex_connection', 'plex_machine_id'];

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
  /**
   * Music only: 'month' or 'year' when MusicBrainz gave only part of the date,
   * 'day' or null for a full one. For a partial date, `date` is the last day
   * of that month or year, so it sorts and counts correctly, but the day is
   * not real and should not be shown.
   */
  date_precision?: string | null;
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
      date_precision: r.date_precision,
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

/** The kinds the Coming soon view lists by default. Mirrors ALL_TYPES in public/feed.js. */
const FEED_KINDS = new Set(['album', 'ep', 'movie', 'show']);

/**
 * How many rows Coming soon shows as it first opens: the next seven days in
 * Sydney, things already on the server included, cinema-only films left out,
 * and each show's episodes folded into one row the way the page groups them.
 * Mirrors applyFilters, DEFAULT_HORIZONS and DEFAULT_HELD in public/feed.js,
 * which is the view this number has to agree with.
 */
export function upcomingWeekCount(rows: FeedItem[], from: string = today()): number {
  const cutoff = shiftDate(from, 7);
  const shows = new Set<string>();
  let n = 0;
  for (const r of rows) {
    if (r.date && r.date > cutoff) continue;
    if (r.date_kind === 'cinema') continue;
    if (!FEED_KINDS.has(r.kind)) continue;
    if (r.source === 'episode' && r.group) {
      if (shows.has(r.group)) continue;
      shows.add(r.group);
    }
    n += 1;
  }
  return n;
}

/* ------------------------------------------------------------------ routes */

/**
 * One handler per method and path. A handler that has nothing more to say
 * returns nothing; one that answers early with bad() returns that. Kept as a
 * table so every route can be found, and tested, by its key.
 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>;

export const ROUTES: Readonly<Record<string, RouteHandler>> = {
  'GET /api/state': async (req, res, url) => {
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
      restart_needed: restartNeeded(),
      counts: {
        out: music.out + watch.out + eps.out,
        upcoming: music.upcoming + watch.upcoming + eps.upcoming,
        upcoming_week: upcomingWeekCount(buildFeed('upcoming', recentDays)),
        artists: music.artists,
        artists_active: music.artists,
        artists_present: music.artists_present,
        unresolved: music.unresolved,
        watchlist: watch.listed,
      },
      progress: getProgress(),
      scans: store.recentScans(),
    });
  },

  'GET /api/releases': async (req, res, url) => {
    const raw = url.searchParams.get('view') ?? 'out';
    const kind: 'out' | 'upcoming' | 'dismissed' =
      raw === 'upcoming' ? 'upcoming' : raw === 'dismissed' ? 'dismissed' : 'out';
    const recentDays = Number(store.getSetting('recent_days')) || 180;
    send(res, 200, { releases: buildFeed(kind, recentDays) });
  },

  'POST /api/releases/dismiss': async (req, res, url) => {
    const body = await readJson(req);
    const id = String(body.id ?? body.mb_id ?? '');
    const source = String(body.source ?? 'music');
    if (!id) return bad(res, 'id is required');
    const dismissed = body.dismissed !== false;
    if (source === 'episode') dismissEpisode(id, dismissed);
    else if (source === 'watchlist') wl.dismissWatchlistItem(id, dismissed);
    else store.dismissRelease(id, dismissed);
    send(res, 200, { ok: true });
  },

  /* ----------------------------------------------------------- artists */
  'GET /api/artists': async (req, res, url) => {
    send(res, 200, {
      artists: store.allArtists().map((a) => ({
        ...a,
        mb_candidates: a.mb_candidates ? (JSON.parse(a.mb_candidates) as unknown) : null,
      })),
    });
  },

  'POST /api/artists/mute': async (req, res, url) => {
    const body = await readJson(req);
    const key = String(body.plex_key ?? '');
    if (!key) return bad(res, 'plex_key is required');
    store.setArtistMuted(key, body.muted !== false);
    send(res, 200, { ok: true });
  },

  'POST /api/artists/mbid': async (req, res, url) => {
    const body = await readJson(req);
    const key = String(body.plex_key ?? '');
    const mbid = String(body.mbid ?? '').trim();
    if (!key) return bad(res, 'plex_key is required');
    if (mbid && !isMbid(mbid)) return bad(res, 'That does not look like a MusicBrainz artist ID.');
    store.setArtistMbid(key, mbid || null, mbid ? 'manual' : 'pending');
    // Pointing a Plex artist at the ID of one followed by hand makes them the
    // same artist, so the two rows become one straight away.
    if (mbid) store.mergeManualArtists();
    send(res, 200, { ok: true });
  },

  /* --------------------------------------------------------- watchlist */
  'GET /api/watchlist': async (req, res, url) => {
    send(res, 200, {
      items: wl.allWatchlistRows().map((r) => ({
        ...r,
        thumb_url: `/thumb?wl=${encodeURIComponent(r.rating_key)}`,
      })),
      removals: wl.recentRemovals(),
    });
  },

  'GET /api/watchlist/gaps': async (req, res, url) => {
    send(res, 200, { shows: wl.libraryShowGaps() });
  },

  'POST /api/watchlist/remove': async (req, res, url) => {
    const body = await readJson(req);
    const key = String(body.rating_key ?? '');
    if (!key) return bad(res, 'rating_key is required');
    if (!isDiscoverKey(key)) return bad(res, 'That is not a watchlist item key.');
    await removeItem(key);
    send(res, 200, { ok: true });
  },

  'POST /api/watchlist/restore': async (req, res, url) => {
    const body = await readJson(req);
    const key = String(body.rating_key ?? '');
    if (!key) return bad(res, 'rating_key is required');
    if (!isDiscoverKey(key)) return bad(res, 'That is not a watchlist item key.');
    await restoreItem(key);
    send(res, 200, { ok: true });
  },

  /**
   * Each tab asks for only what it shows. Measured on a real library:
   * holdings and watchlist are seconds, schedules is the slow one.
   */
  'POST /api/refresh': async (req, res, url) => {
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
      return;
    }
    const parts = JOBS[job];
    if (!parts) return bad(res, `Unknown refresh job: ${job}`);
    void runRefresh(parts, true);
    send(res, 202, { started: true, job });
  },

  'POST /api/watchlist/sync': async (req, res, url) => {
    if (getProgress().running) {
      return bad(res, 'Something is already running. Wait for it to finish.');
    }
    // Not awaited: a refresh takes minutes, so the page polls /api/state.
    void runRefresh(undefined, true);
    send(res, 202, { started: true });
  },

  'POST /api/watchlist/test': async (req, res, url) => {
    const token = store.getSetting('plex_token');
    if (!token) return bad(res, 'Save your Plex token first.');
    try {
      const account = await verifyAccount(token);
      send(res, 200, { ok: true, message: `Signed in as ${account}.` });
    } catch (err) {
      send(res, 200, { ok: false, message: (err as Error).message });
    }
  },

  'GET /api/library': async (req, res, url) => {
    send(res, 200, libraryReport());
  },

  /* --------------------------------------------------------- dashboard */
  'GET /api/dash/sessions': async (req, res, url) => {
    const now = await nowPlaying();
    send(res, 200, {
      ...now,
      streams: now.streams.map((s) => ({ ...s, thumb: s.thumb ? `/thumb?px=${encodeURIComponent(s.thumb)}` : null })),
    });
  },

  'POST /api/dash/stop': async (req, res, url) => {
    const body = await readJson(req);
    const sessionId = String(body.session_id ?? '');
    if (!sessionId) return bad(res, 'session_id is required');
    const reason = String(body.reason ?? '').trim() || 'The server owner stopped this stream.';
    await stopStream(sessionId, reason.slice(0, 200));
    send(res, 200, { ok: true });
  },

  'GET /api/dash/library': async (req, res, url) => {
    const [stats, added] = await Promise.all([libraryStats(), recentlyAdded()]);
    send(res, 200, {
      libraries: stats,
      added: added.map((a) => ({ ...a, thumb: a.thumb ? `/thumb?px=${encodeURIComponent(a.thumb)}` : null })),
    });
  },

  'GET /api/dash/history': async (req, res, url) => {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const h = await history(days);
    send(res, 200, {
      ...h,
      recent: h.recent.map((p) => ({ ...p, thumb: p.thumb ? `/thumb?px=${encodeURIComponent(p.thumb)}` : null })),
    });
  },

  /* ----------------------------------------------------------- search */
  'GET /api/search': async (req, res, url) => {
    const q = url.searchParams.get('q') ?? '';
    const raw = url.searchParams.get('kinds');
    const kinds = new Set(raw ? raw.split(',').filter(Boolean) : ['movie', 'show', 'artist']);
    send(res, 200, await search(q, kinds));
  },

  'POST /api/search/add': async (req, res, url) => {
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
      return;
    }
    if (!isDiscoverKey(id)) return bad(res, 'That is not a film or show key.');
    await addFilmOrShow(id);
    send(res, 200, {
      ok: true,
      message: `Added to your Plex watchlist. It appears here after the next check.`,
    });
  },

  'GET /api/search/details': async (req, res, url) => {
    const id = url.searchParams.get('id') ?? '';
    const kind = url.searchParams.get('kind') ?? 'movie';
    if (!id) return bad(res, 'id is required');
    if (kind !== 'movie' && kind !== 'show') {
      return bad(res, 'Details are only available for films and shows.');
    }
    if (!isDiscoverKey(id)) return bad(res, 'That is not a film or show key.');
    send(res, 200, await getDetails(kind, id));
  },

  'POST /api/search/untrack': async (req, res, url) => {
    const body = await readJson(req);
    const id = String(body.id ?? '');
    if (!id) return bad(res, 'id is required');
    untrackArtist(id);
    send(res, 200, { ok: true });
  },

  /* ---------------------------------------------------------- youtube */
  'GET /api/youtube': async (req, res, url) => {
    send(
      res,
      200,
      await resolveYoutube({
        kind: url.searchParams.get('kind') ?? 'album',
        title: url.searchParams.get('title') ?? '',
        artist: url.searchParams.get('subtitle') ?? '',
      }),
    );
  },

  'POST /api/youtube/clear': async (req, res, url) => {
    send(res, 200, { ok: true, cleared: clearYoutubeCache() });
  },

  /* ------------------------------------------------------- suggestions */
  'GET /api/suggestions': async (req, res, url) => {
    send(res, 200, { suggestions: listSuggestions() });
  },

  'POST /api/suggestions/build': async (req, res, url) => {
    if (suggestionsJob.progress().running) return bad(res, 'Suggestions are already being built.');
    const body = await readJson(req);
    const what = body.what === 'music' || body.what === 'video' ? body.what : 'all';
    runInBackground(suggestionsJob, (say) => buildSuggestions(what, say));
    send(res, 202, { started: true });
  },

  'GET /api/suggestions/progress': async (req, res, url) => {
    const { running, message } = suggestionsJob.progress();
    send(res, 200, { running, message });
  },

  'POST /api/suggestions/hide': async (req, res, url) => {
    const body = await readJson(req);
    const kind = String(body.kind ?? '');
    const id = String(body.id ?? '');
    if (!kind || !id) return bad(res, 'kind and id are required');
    hideSuggestion(kind, id, body.hidden !== false);
    send(res, 200, { ok: true });
  },

  /* ---------------------------------------------------------- trending */
  'GET /api/trending': async (req, res, url) => {
    // Converted to a Sydney calendar date here, once, rather than in the
    // page: the stored timestamp is UTC, and the tab needs the day it
    // reads as in Sydney, not the day it happens to fall on in UTC.
    const at = builtAt();
    const builtDates = Object.fromEntries(
      Object.entries(at).map(([kind, iso]) => [kind, iso ? sydneyDate(iso) : null]),
    );
    // Opening the tab on charts more than a week old starts a rebuild behind
    // the answer; the page sees `building` and polls progress as for a press.
    maybeAutoBuildTrending();
    send(res, 200, {
      items: listTrending(),
      built_at: builtDates,
      has_tmdb_key: store.getSetting('tmdb_api_key').trim() !== '',
      stale: trendingIsStale(),
      building: trendingJob.progress().running,
    });
  },

  'POST /api/trending/build': async (req, res, url) => {
    if (trendingJob.progress().running) return bad(res, 'Trending is already being built.');
    // Not awaited: a build takes minutes, dominated by MusicBrainz at one
    // request a second, so the page polls /api/trending/progress instead.
    runInBackground(trendingJob, (say) => buildTrending(say));
    send(res, 202, { started: true });
  },

  'GET /api/trending/progress': async (req, res, url) => {
    // Polled every second or so, so this must stay cheap: no database work,
    // just the job state the build above keeps updated.
    const { running, message } = trendingJob.progress();
    send(res, 200, { running, message });
  },

  'POST /api/trending/hide': async (req, res, url) => {
    const body = await readJson(req);
    const kind = String(body.kind ?? '');
    const id = String(body.id ?? '');
    if (!kind || !id) return bad(res, 'kind and id are required');
    hideTrending(kind, id, body.hidden !== false);
    send(res, 200, { ok: true });
  },

  /* ----------------------------------------------------------- friends */
  'GET /api/friends': async (req, res, url) => {
    const token = store.getSetting('plex_token');
    if (!token) return bad(res, 'Add your Plex token in Settings first.');
    try {
      const friends = await cachedFriends(communityGql(token));
      send(res, 200, { friends });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  },

  'GET /api/friends/watchlist': async (req, res, url) => {
    const token = store.getSetting('plex_token');
    if (!token) return bad(res, 'Add your Plex token in Settings first.');
    const which = url.searchParams.get('friend') ?? 'all';
    const gql = communityGql(token);
    try {
      const friends = await cachedFriends(gql);
      const chosen = which === 'all' ? friends : friends.filter((f) => f.id === which);
      if (chosen.length === 0) return bad(res, 'That friend is not on your account.');
      const notes: string[] = [];
      const lists: { friend: string; items: Awaited<ReturnType<typeof cachedWatchlist>> }[] = [];
      for (const f of chosen) {
        try {
          lists.push({ friend: f.name, items: await cachedWatchlist(gql, f.id) });
        } catch (err) {
          // One private or failing watchlist must not empty the whole view.
          notes.push(`${f.name}: ${(err as Error).message}`);
        }
      }
      const items = flagItems(mergeAcrossFriends(lists), wl.listedKeys(), wl.libraryTitles());
      send(res, 200, { items, notes });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  },

  'POST /api/friends/refresh': async (req, res, url) => {
    clearFriendCache();
    send(res, 200, { ok: true });
  },

  /* ------------------------------------------------------------ lyrics */
  'GET /api/lyrics/tracks': async (req, res, url) => {
    const artist = url.searchParams.get('artist') ?? '';
    const album = url.searchParams.get('album') ?? '';
    const library = url.searchParams.get('library') === '1';
    if (!artist && !album && !library) return bad(res, 'artist, album or library is required');
    if ((artist && !isPlexKey(artist)) || (album && !isPlexKey(album))) {
      return bad(res, 'artist and album must be Plex library keys.');
    }
    const token = store.getSetting('plex_token');
    const section = store.getSetting('plex_section');
    if (library && !section) return bad(res, 'Choose a music library in Settings first.');
    try {
      const tracks = await withPlex((base) =>
        library
          ? fetchTracks(base, token, section, 'library')
          : album
            ? fetchTracks(base, token, album, 'album')
            : fetchTracks(base, token, artist, 'artist'),
      );
      // The whole library was just listed, which is as good a count as any.
      if (library) rememberTrackCount(tracks.length);
      send(res, 200, {
        tracks: trackStates(tracks),
        albums: artist ? store.albumsOf(artist).map((a) => ({ plex_key: a.plex_key, title: a.title, year: a.year })) : [],
      });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  },

  'POST /api/lyrics/fetch': async (req, res, url) => {
    if (lyricsProgress().running) return bad(res, 'A lyrics job is already running.');
    const body = await readJson(req);
    const tracks = trackList(body.tracks);
    if (tracks.length === 0) return bad(res, 'No tracks to fetch lyrics for.');
    // Not awaited: an album is seconds, an artist can be a minute, so the
    // page polls /api/lyrics/progress.
    void fetchLyrics(tracks).catch(() => {});
    send(res, 202, { started: true, count: tracks.length });
  },

  'POST /api/lyrics/export': async (req, res, url) => {
    if (lyricsProgress().running) return bad(res, 'A lyrics job is already running.');
    const body = await readJson(req);
    const keys = Array.isArray(body.keys) ? body.keys.map(String).filter(Boolean) : [];
    if (keys.length === 0) return bad(res, 'No stored lyrics to save.');
    if (!keys.every(isPlexKey)) return bad(res, 'Every key must be a Plex library key.');
    // Not awaited: a whole library is thousands of files; the page polls progress.
    void exportLyrics(keys);
    send(res, 202, { started: true, count: keys.length });
  },

  /**
   * Answers from stored numbers only. The track count is the one Plex last
   * gave; when there is none for this library, or it is a day old, one quick
   * read is started behind the answer, so the next asking has it.
   */
  'GET /api/lyrics/summary': async (req, res, url) => {
    const { tracks, fresh } = cachedTrackCount();
    if (!fresh && store.isConfigured()) void refreshTrackCount().catch(() => {});
    send(res, 200, { tracks, ...lyricCounts() });
  },

  'GET /api/lyrics/progress': async (req, res, url) => {
    send(res, 200, lyricsProgress());
  },

  'GET /api/lyrics/one': async (req, res, url) => {
    const key = url.searchParams.get('rating_key') ?? '';
    if (!key) return bad(res, 'rating_key is required');
    send(res, 200, { lyric: getLyric(key) ?? null });
  },

  'POST /api/lyrics/manual': async (req, res, url) => {
    const body = await readJson(req);
    const [track] = trackList([body.track]);
    const text = String(body.text ?? '').trim();
    if (!track) return bad(res, 'A track is required.');
    if (!text) return bad(res, 'Paste the lyrics first.');
    // Timed lines such as [01:23.45] mean an LRC file was pasted.
    const synced = /^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/m.test(text);
    saveLyric(track, { synced: synced ? text : null, plain: synced ? null : text, instrumental: false }, 'manual');
    send(res, 200, { ok: true });
  },

  /* ---------------------------------------------------------- settings */
  'GET /api/settings': async (req, res, url) => {
    // The sign-in bookkeeping is the server's own business, not a setting.
    const settings = Object.fromEntries(
      Object.entries(store.getSettings()).filter(([key]) => !key.startsWith('auth_')),
    );
    send(res, 200, {
      settings: {
        ...settings,
        plex_token: settings.plex_token ? '********' : '',
        tmdb_api_key: settings.tmdb_api_key ? '********' : '',
      },
      token_set: Boolean(settings.plex_token),
      // 'server' on the NAS, where the phone and every browser share one library.
      platform: AUTH_REQUIRED ? 'server' : 'desktop',
      version: APP_VERSION,
      releases_url: RELEASES_URL,
    });
  },

  'POST /api/settings': async (req, res, url) => {
    const body = await readJson(req);
    // The music section's key goes into Plex URL paths on every check.
    if (body.plex_section !== undefined && body.plex_section !== '' && !isPlexKey(String(body.plex_section))) {
      return bad(res, 'plex_section must be a Plex library key.');
    }
    // Each Settings section saves on its own and sends only its own keys, so
    // only the keys present are written; anything absent is left as it was.
    for (const [key, value] of Object.entries(body)) {
      if (!SETTABLE.has(key)) continue;
      if ((key === 'plex_token' || key === 'tmdb_api_key') && value === '********') continue;
      store.setSetting(key, String(value));
    }
    // Automatic mode has no typed address, so find one now. If the server
    // cannot be reached this minute, the next check tries again. Only a save
    // that touched the connection asks plex.tv: saving the feed options has
    // nothing to do with where the server is, and should not wait on it.
    let warning: string | null = null;
    const touchesConnection = CONNECTION_KEYS.some((k) => body[k] !== undefined);
    if (touchesConnection && store.getSetting('plex_connection') === 'auto') {
      try {
        await ensurePlexUrl();
      } catch (err) {
        // Saved regardless. Each check looks the server up again.
        warning = `Saved, but the server could not be reached just now: ${(err as Error).message}`;
      }
    }
    send(res, 200, { ok: true, configured: store.isConfigured(), warning });
  },

  'POST /api/plex/servers': async (req, res, url) => {
    const body = await readJson(req);
    const token = tokenFrom(body);
    if (!token) return bad(res, 'Enter your Plex token first.');
    try {
      const servers = await listServers(token);
      send(res, 200, { servers: servers.map((s) => ({ machine_id: s.machineId, name: s.name })) });
    } catch (err) {
      return bad(res, (err as Error).message);
    }
  },

  'POST /api/plex/test': async (req, res, url) => {
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
        return;
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
      return;
    }
    const plexUrl = String(body.plex_url ?? store.getSetting('plex_url'));
    if (!plexUrl || !token) return bad(res, 'Both a server URL and a token are needed.');
    send(res, 200, await testConnection(plexUrl, token));
  },

  /* -------------------------------------------------------------- scan */
  'POST /api/scan/start': async (req, res, url) => {
    if (getProgress().running) {
      send(res, 200, { started: false, progress: getProgress() });
      return;
    }
    void runScan();
    send(res, 202, { started: true });
  },

  'POST /api/scan/stop': async (req, res, url) => {
    requestStop();
    send(res, 200, { ok: true });
  },
};


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

    const handler = Object.hasOwn(ROUTES, `${req.method} ${path}`)
      ? ROUTES[`${req.method} ${path}`]
      : undefined;
    if (handler) {
      await handler(req, res, url);
      return true;
    }

    send(res, 404, { error: 'No such endpoint' });
    return true;
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
    return true;
  }
}

const suggestionsJob = createJob();

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
    // An artist's stored thumb first, as the releases feed has always used.
    // Any other key on the home server (a film, episode or show from the
    // Library tab) gets that item's own poster, shrunk by Plex to card size.
    // Only a plain number gets that far, so the path cannot be steered.
    const artist = store.getArtist(plexKey);
    if (artist) target = thumbUrl(store.getSetting('plex_url'), token, artist.thumb);
    else if (isPlexKey(plexKey) && store.getSetting('plex_url')) {
      target = thumbUrl(store.getSetting('plex_url'), token, resizedArtPath(`/library/metadata/${plexKey}/thumb`));
    }
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
    // Served from the app's own address, so only plain pictures get through.
    // An SVG (Wikimedia hosts user-made ones) or a page could carry script.
    const type = (upstream.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
      // Private: on the NAS a picture is only handed out after signing in.
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(new Uint8Array(await upstream.arrayBuffer()));
  } catch {
    res.writeHead(404).end();
  }
}
