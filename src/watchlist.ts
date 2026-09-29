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
import { ensurePlexUrl, withPlex } from './plexconnect.ts';
import { nowIso } from './dates.ts';
import { runRefreshPlan, ALL_PARTS, type RefreshPart } from './refreshplan.ts';

export { ALL_PARTS, type RefreshPart };

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

  // Which of these are already on the server, going by the last library read.
  // The holdings part of a refresh is what re-reads the server.
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
 * Several parts report at once, so the strip shows every part still running,
 * joined, rather than whichever spoke last.
 */
function progressBoard(onProgress?: (m: string) => void) {
  const lines = new Map<string, string>();
  return (part: string) => (m: string | null) => {
    if (m === null) lines.delete(part);
    else lines.set(part, m);
    onProgress?.([...lines.values()].join(' · '));
  };
}

/**
 * The quick pass: re-read what Plex holds, drop anything from the lists that has
 * since arrived, and sync the watchlist. No MusicBrainz, so it takes seconds
 * rather than the half hour a full scan needs.
 *
 * `force` walks every show's schedule rather than only those that could have
 * changed. A pressed button forces; the start-up sync does not.
 */
export async function refreshLibraryState(
  onProgress?: (m: string) => void,
  parts: RefreshPart[] = ALL_PARTS,
  force = false,
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
  let failures = 0;
  const failed = (note: string): void => {
    failures += 1;
    result.message += `${note} `;
  };
  const board = progressBoard(onProgress);

  if (settings.watchlist_enabled !== '1') {
    for (const part of ['watchlist', 'schedules', 'filmdates'] as const) want.delete(part);
  }

  await runRefreshPlan(
    {
      async holdings() {
        const say = board('holdings');
        // In automatic mode, work out where the server is from here before
        // anything talks to it. Manual mode keeps the saved address.
        say('Finding your Plex server');
        try {
          const relayNote = await ensurePlexUrl();
          if (relayNote) {
            say(relayNote);
            result.message += `${relayNote} `;
          }
        } catch (err) {
          failed((err as Error).message);
        }

        say('Re-reading your Plex music library');
        try {
          if (settings.plex_section) {
            const albums = await withPlex((url) =>
              fetchAlbums(url, settings.plex_token, settings.plex_section),
            );
            store.replacePlexAlbums(albums);
            result.owned = store.refreshOwnedFlags();
          }
        } catch (err) {
          failed(`Music library check failed: ${(err as Error).message}.`);
        }

        // The server id is what makes a deep link back into Plex possible.
        try {
          const machine = await fetchMachineId(store.getSetting('plex_url'), settings.plex_token);
          if (machine) store.setSetting('plex_machine_id', machine);
        } catch {
          // Without it, links are simply not offered.
        }

        say('Checking films and shows already on the server');
        try {
          await withPlex(async (url) => {
            const sections = await listVideoSections(url, settings.plex_token);
            if (sections.length > 0) {
              const guids = await fetchLibraryGuids(url, settings.plex_token, sections);
              wl.replaceLibraryGuids(guids);
            }
            const showSections = sections.filter((x) => x.type === 'show').map((x) => x.key);
            if (showSections.length > 0) {
              result.heldEpisodes = await syncLocalEpisodes(
                url,
                settings.plex_token,
                showSections,
                say,
              );
            }
          });
        } catch (err) {
          failed(`Film and TV check failed: ${(err as Error).message}.`);
        }
        say(null);
      },
      async watchlist() {
        const say = board('watchlist');
        try {
          result.watchlist = await syncWatchlist(say);
        } catch (err) {
          failed(`Watchlist sync failed: ${(err as Error).message}.`);
        }
        say(null);
      },
      async schedules() {
        const say = board('schedules');
        try {
          result.episodes = await syncEpisodes(say, force);
        } catch (err) {
          failed(`Episode check failed: ${(err as Error).message}.`);
        }
        say(null);
      },
      async filmdates() {
        const say = board('filmdates');
        try {
          const films = await syncFilmDates(say);
          if (!films.skipped) result.message += `${films.message} `;
        } catch (err) {
          failed(`Film date check failed: ${(err as Error).message}.`);
        }
        say(null);
      },
    },
    want,
  );

  // Flags depend on both the library read and the watchlist, so once, at the end.
  result.inLibrary = wl.refreshInLibraryFlags();

  // Only a clean run of everything lets the next start skip its own sync.
  if (failures === 0 && ALL_PARTS.every((p) => want.has(p))) {
    store.setSetting('last_refresh_at', nowIso());
  }

  const w = result.watchlist;
  const e = result.episodes;
  result.message =
    result.message +
    `${result.owned} releases already held, ${result.inLibrary} watchlist items and ` +
    `${result.heldEpisodes} episodes on the server` +
    (w ? `, ${w.total} watchlist items (${w.added} new, ${w.removedInPlex} removed in Plex)` : '') +
    (e
      ? `, ${e.episodes} episodes across ${e.shows} continuing shows ` +
        `(${e.timed} with a confirmed air time` +
        (e.skipped ? `, ${e.skipped} shows unchanged since last time` : '') +
        ').'
      : '.');
  return result;
}
