/**
 * Two-way sync between the Plex Watchlist and the local copy.
 *
 * Plex offers no webhook for watchlist changes, so this polls and does a
 * three-way merge. Each item remembers the state Plex and the app last agreed
 * on, which is what lets "you removed it in Plex" be told apart from "you
 * removed it in the app".
 */
import * as store from './db.ts';
import * as wl from './watchlist-db.ts';
import type { WatchlistRow } from './watchlist-db.ts';
import {
  fetchWatchlist,
  removeFromWatchlist,
  addToWatchlist,
  type WatchlistItem,
} from './plexdiscover.ts';
import { fetchLibraryGuids, listVideoSections, fetchAlbums } from './plex.ts';
import { syncEpisodes, syncLocalEpisodes, type EpisodeSyncResult } from './episodes.ts';
import { syncFilmDates } from './tmdb.ts';
import { fetchMachineId } from './library.ts';

/**
 * A sync that wants to push more removals than this has almost certainly gone
 * wrong. Stopping is cheaper than emptying someone's watchlist.
 */
const MAX_PUSHED_REMOVALS = 10;

export interface SyncResult {
  added: number;
  removedInPlex: number;
  pushedToPlex: number;
  relisted: number;
  events: number;
  inLibrary: number;
  total: number;
  importOnly: boolean;
  blocked: string | null;
}

export async function syncWatchlist(
  onProgress?: (message: string) => void,
): Promise<SyncResult> {
  const settings = store.getSettings();
  const token = settings.plex_token;
  if (!token) throw new Error('No Plex token stored.');

  const result: SyncResult = {
    added: 0,
    removedInPlex: 0,
    pushedToPlex: 0,
    relisted: 0,
    events: 0,
    inLibrary: 0,
    total: 0,
    importOnly: false,
    blocked: null,
  };

  // An empty table means this is the first sync. Import only: never push a
  // removal before there is a baseline to judge against.
  const firstSync = wl.watchlistCount() === 0;
  result.importOnly = firstSync;

  onProgress?.('Reading your Plex watchlist');
  const remote = await fetchWatchlist(token);
  const remoteByKey = new Map(remote.map((i) => [i.rating_key, i]));
  result.total = remote.length;

  const local = wl.allWatchlistRows();
  const localByKey = new Map(local.map((r) => [r.rating_key, r]));

  // Work out the pushes first so the cap can be checked before anything is sent.
  const toPush: WatchlistRow[] = [];
  for (const row of local) {
    if (row.state === 'removed' && row.baseline === 'listed' && remoteByKey.has(row.rating_key)) {
      toPush.push(row);
    }
  }
  if (!firstSync && toPush.length > MAX_PUSHED_REMOVALS) {
    result.blocked =
      `Stopped: ${toPush.length} items were queued for removal from Plex in one go. ` +
      'That looks wrong, so nothing was sent. Restore what you did not mean to remove, then sync again.';
    return result;
  }

  onProgress?.('Comparing against the last sync');

  for (const row of local) {
    const remoteItem = remoteByKey.get(row.rating_key);

    if (row.state === 'listed' && row.baseline === 'listed' && !remoteItem) {
      // Gone from Plex since the last sync: follow it here.
      wl.setWatchlistState(row.rating_key, 'removed', 'removed');
      wl.logRemoval(row, 'plex');
      result.removedInPlex += 1;
      continue;
    }

    if (row.state === 'removed' && row.baseline === 'removed' && remoteItem) {
      // Added back in Plex.
      wl.setWatchlistState(row.rating_key, 'listed', 'listed');
      wl.markRemovalRestored(row.rating_key);
      result.relisted += 1;
    }

    if (remoteItem && row.state === 'listed') {
      const event = detectEvent(row, remoteItem);
      wl.refreshWatchlistItem(row.rating_key, toNewItem(remoteItem), event);
      if (event) result.events += 1;
    }
  }

  // Push the removals the app is responsible for.
  if (!firstSync) {
    for (const row of toPush) {
      onProgress?.(`Removing ${row.title} from Plex`);
      try {
        await removeFromWatchlist(token, row.rating_key);
        wl.setWatchlistState(row.rating_key, 'removed', 'removed');
        result.pushedToPlex += 1;
      } catch {
        // Leave the baseline alone so the next sync tries again.
      }
    }
  } else {
    // First sync: adopt whatever Plex says without pushing anything.
    for (const row of toPush) {
      wl.setWatchlistState(row.rating_key, 'listed', 'listed');
    }
  }

  onProgress?.('Recording new items');
  for (const item of remote) {
    if (localByKey.has(item.rating_key)) continue;
    wl.insertWatchlistItem(toNewItem(item));
    result.added += 1;
  }

  // Which of these are already on the server.
  onProgress?.('Checking what is already in your library');
  try {
    const sections = await listVideoSections(settings.plex_url, token);
    if (sections.length > 0) {
      const guids = await fetchLibraryGuids(settings.plex_url, token, sections);
      wl.replaceLibraryGuids(guids);
    }
  } catch {
    // The local server being unreachable must not fail the whole sync; the
    // in_library flags simply stay as they were.
  }
  result.inLibrary = wl.refreshInLibraryFlags();

  return result;
}

/** A show reports when its last episode or season date moves forward. */
function detectEvent(
  row: WatchlistRow,
  next: WatchlistItem,
): { kind: string; at: string } | null {
  if (next.type !== 'show') return null;

  const seasonMoved =
    next.last_season_at !== null &&
    (row.last_season_at === null || next.last_season_at > row.last_season_at);
  if (seasonMoved) return { kind: 'new season', at: next.last_season_at! };

  const episodeMoved =
    next.last_episode_at !== null &&
    row.last_episode_at !== null &&
    next.last_episode_at > row.last_episode_at;
  if (episodeMoved) return { kind: 'new episode', at: next.last_episode_at! };

  return null;
}

function toNewItem(i: WatchlistItem): wl.NewItem {
  return {
    rating_key: i.rating_key,
    guid: i.guid,
    type: i.type,
    title: i.title,
    year: i.year,
    thumb: i.thumb,
    release_date: i.release_date,
    last_episode_at: i.last_episode_at,
    last_season_at: i.last_season_at,
    season_count: i.season_count,
    episode_count: i.episode_count,
    continuing: i.continuing,
    public_url: i.public_url,
    added_at: i.added_at,
  };
}

/**
 * Removing from the app marks the item locally and pushes straight away, so the
 * change lands in Plex without waiting for the next sync.
 */
export async function removeItem(ratingKey: string): Promise<void> {
  const row = wl.getWatchlistRow(ratingKey);
  if (!row) throw new Error('That item is not on the watchlist.');
  const token = store.getSetting('plex_token');
  if (!token) throw new Error('No Plex token stored.');

  // Record locally first. If the push fails the next sync retries it, rather
  // than the removal being silently lost.
  wl.setWatchlistState(ratingKey, 'removed', row.baseline);
  wl.logRemoval(row, 'app');

  await removeFromWatchlist(token, ratingKey);
  wl.setWatchlistState(ratingKey, 'removed', 'removed');
}

/** Undo. Puts an item back on the Plex watchlist and relists it here. */
export async function restoreItem(ratingKey: string): Promise<void> {
  const token = store.getSetting('plex_token');
  if (!token) throw new Error('No Plex token stored.');

  await addToWatchlist(token, ratingKey);
  if (wl.getWatchlistRow(ratingKey)) {
    wl.setWatchlistState(ratingKey, 'listed', 'listed');
  }
  wl.markRemovalRestored(ratingKey);
}

export interface RefreshResult {
  owned: number;
  inLibrary: number;
  heldEpisodes: number;
  watchlist: SyncResult | null;
  episodes: EpisodeSyncResult | null;
  message: string;
}

/**
 * The quick pass: re-read what Plex holds, drop anything from the lists that has
 * since arrived, and sync the watchlist. No MusicBrainz, so it takes seconds
 * rather than the half hour a full scan needs.
 */
/**
 * The named pieces of a refresh. Measured against a real library: holdings and
 * watchlist are seconds because they are LAN or a handful of plex.tv calls;
 * schedules walks two requests per continuing show and is the slow one.
 */
export type RefreshPart = 'holdings' | 'watchlist' | 'schedules' | 'filmdates';

export const ALL_PARTS: RefreshPart[] = ['holdings', 'watchlist', 'schedules', 'filmdates'];

export async function refreshLibraryState(
  onProgress?: (m: string) => void,
  parts: RefreshPart[] = ALL_PARTS,
): Promise<RefreshResult> {
  const want = new Set(parts);
  const settings = store.getSettings();
  const result: RefreshResult = {
    owned: 0,
    inLibrary: 0,
    heldEpisodes: 0,
    watchlist: null,
    episodes: null,
    message: '',
  };

  if (want.has('holdings')) {
    onProgress?.('Re-reading your Plex music library');
    try {
      if (settings.plex_section) {
        const albums = await fetchAlbums(settings.plex_url, settings.plex_token, settings.plex_section);
        store.replacePlexAlbums(albums);
        result.owned = store.refreshOwnedFlags();
      }
    } catch (err) {
      result.message += `Music library check failed: ${(err as Error).message}. `;
    }

    // The server id is what makes a deep link back into Plex possible.
    try {
      const machine = await fetchMachineId(settings.plex_url, settings.plex_token);
      if (machine) store.setSetting('plex_machine_id', machine);
    } catch {
      // Without it, links are simply not offered.
    }

    onProgress?.('Checking films and shows already on the server');
    try {
      const sections = await listVideoSections(settings.plex_url, settings.plex_token);
      if (sections.length > 0) {
        const guids = await fetchLibraryGuids(settings.plex_url, settings.plex_token, sections);
        wl.replaceLibraryGuids(guids);
      }
      const showSections = sections.filter((x) => x.type === 'show').map((x) => x.key);
      if (showSections.length > 0) {
        result.heldEpisodes = await syncLocalEpisodes(
          settings.plex_url,
          settings.plex_token,
          showSections,
          onProgress,
        );
      }
    } catch (err) {
      result.message += `Film and TV check failed: ${(err as Error).message}. `;
    }
  }
  result.inLibrary = wl.refreshInLibraryFlags();

  if (settings.watchlist_enabled === '1') {
    if (want.has('watchlist')) {
      try {
        result.watchlist = await syncWatchlist(onProgress);
        result.inLibrary = wl.refreshInLibraryFlags();
      } catch (err) {
        result.message += `Watchlist sync failed: ${(err as Error).message}. `;
      }
    }
    if (want.has('schedules')) {
      try {
        result.episodes = await syncEpisodes(onProgress);
      } catch (err) {
        result.message += `Episode check failed: ${(err as Error).message}. `;
      }
    }
    if (want.has('filmdates')) {
      try {
        const films = await syncFilmDates(onProgress);
        if (!films.skipped) result.message += `${films.message} `;
      } catch (err) {
        result.message += `Film date check failed: ${(err as Error).message}. `;
      }
    }
  }

  const w = result.watchlist;
  result.message =
    result.message +
    `${result.owned} releases already held, ${result.inLibrary} watchlist items and ` +
    `${result.heldEpisodes} episodes on the server` +
    (w ? `, ${w.total} watchlist items (${w.added} new, ${w.removedInPlex} removed in Plex)` : '') +
    (result.episodes
      ? `, ${result.episodes.episodes} episodes across ${result.episodes.shows} continuing shows ` +
        `(${result.episodes.timed} with a confirmed air time).`
      : '.');
  return result;
}
