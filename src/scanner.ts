import * as store from './db.ts';
import type { ArtistRow, MbCandidate } from './db.ts';
import { fetchAlbums, fetchArtists, PlexError } from './plex.ts';
import { browseReleaseGroups, searchArtist, type MbReleaseGroup } from './musicbrainz.ts';
import { normaliseArtistName, normaliseTitle, titleOverlap } from './matching.ts';
import { daysAgo, nowIso } from './dates.ts';
import { refreshLibraryState, type RefreshPart } from './watchlist.ts';

export type Phase =
  | 'idle'
  | 'refresh'
  | 'watchlist'
  | 'plex'
  | 'identify'
  | 'releases'
  | 'done'
  | 'failed'
  | 'stopped';

export interface Progress {
  running: boolean;
  phase: Phase;
  done: number;
  total: number;
  current: string;
  message: string;
  newReleases: number;
  startedAt: string | null;
  finishedAt: string | null;
}

const progress: Progress = {
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  current: '',
  message: '',
  newReleases: 0,
  startedAt: null,
  finishedAt: null,
};

let stopRequested = false;

export function getProgress(): Progress {
  return { ...progress };
}

export function requestStop(): void {
  if (progress.running) stopRequested = true;
}

class Stopped extends Error {}

function checkStop(): void {
  if (stopRequested) throw new Stopped();
}

/* --------------------------------------------------------------- the scan */

export async function runScan(skipQuickRefresh = false): Promise<Progress> {
  if (progress.running) return getProgress();

  const settings = store.getSettings();
  if (!store.isConfigured()) {
    Object.assign(progress, {
      phase: 'failed',
      message: 'Plex is not configured yet. Open Settings and add your server URL and token.',
    });
    return getProgress();
  }

  stopRequested = false;
  Object.assign(progress, {
    running: true,
    phase: 'plex',
    done: 0,
    total: 0,
    current: '',
    message: 'Reading the Plex library',
    newReleases: 0,
    startedAt: nowIso(),
    finishedAt: null,
  });

  const scanId = store.startScanRecord();
  let artistsSeen = 0;
  let watchlistNote = '';

  try {
    /* Phase 0: everything quick. Library, watchlist, episodes, film dates.
       Runs first so the fast results appear before the long music wait.
       The Artists tab skips it, because it only wants the MusicBrainz half. */
    if (!skipQuickRefresh) {
      Object.assign(progress, { phase: 'refresh', done: 0, total: 0 });
      try {
        const quick = await refreshLibraryState((m) => {
          progress.current = m;
        });
        watchlistNote = quick.watchlist?.blocked ?? quick.message;
      } catch (err) {
        // A failure here must not stop the music scan.
        watchlistNote = `Quick refresh failed: ${(err as Error).message}`;
      }
      progress.current = '';
      checkStop();
    }

    /* Phase 1: what does Plex hold ------------------------------------- */
    const { plex_url: url, plex_token: token, plex_section: section } = settings;
    const artists = await fetchArtists(url, token, section);
    const albums = await fetchAlbums(url, token, section);

    // How many albums Plex holds per artist, used for ordering and for the
    // disambiguation tie-break later on.
    const albumCounts = new Map<string, number>();
    for (const album of albums) {
      albumCounts.set(album.artist_key, (albumCounts.get(album.artist_key) ?? 0) + 1);
    }

    for (const a of artists) {
      store.upsertArtist({ ...a, album_count: albumCounts.get(a.plex_key) ?? 0 });
    }
    store.markAbsentArtists(artists.map((a) => a.plex_key));
    store.replacePlexAlbums(albums);
    artistsSeen = artists.length;
    progress.message = `${artists.length} artists and ${albums.length} albums in Plex`;
    checkStop();

    /* Phase 2: give every artist a MusicBrainz identity ------------------ */
    const unidentified = store.artistsNeedingMbid();
    Object.assign(progress, {
      phase: 'identify',
      done: 0,
      total: unidentified.length,
      message: `Identifying ${unidentified.length} artists in MusicBrainz`,
    });

    for (const artist of unidentified) {
      checkStop();
      progress.current = artist.name;
      await identifyArtist(artist);
      progress.done += 1;
    }

    /* Phase 3: what have they released ---------------------------------- */
    const staleDays = Number(settings.stale_days) || 7;
    const due = store.artistsDueForCheck(staleDays);
    Object.assign(progress, {
      phase: 'releases',
      done: 0,
      total: due.length,
      current: '',
      message: `Checking ${due.length} artists for new releases`,
    });

    const wanted = wantedTypes(settings);
    for (const artist of due) {
      checkStop();
      progress.current = artist.name;
      try {
        progress.newReleases += await checkArtistReleases(artist, wanted);
        store.markArtistChecked(artist.plex_key);
      } catch (err) {
        // One artist failing must not take the whole scan down with it.
        store.setArtistError(artist.plex_key, (err as Error).message);
      }
      progress.done += 1;
    }

    Object.assign(progress, {
      running: false,
      phase: 'done',
      current: '',
      finishedAt: nowIso(),
      message: `Done. ${progress.newReleases} new ${
        progress.newReleases === 1 ? 'release' : 'releases'
      } found.${watchlistNote ? ` ${watchlistNote}` : ''}`,
    });
    store.finishScanRecord(scanId, 'complete', artistsSeen, progress.newReleases, progress.message);
  } catch (err) {
    const stopped = err instanceof Stopped;
    const message = stopped
      ? 'Scan stopped. Progress so far has been saved.'
      : err instanceof PlexError
        ? err.message
        : `Scan failed: ${(err as Error).message}`;
    Object.assign(progress, {
      running: false,
      phase: stopped ? 'stopped' : 'failed',
      current: '',
      finishedAt: nowIso(),
      message,
    });
    store.finishScanRecord(
      scanId,
      stopped ? 'stopped' : 'failed',
      artistsSeen,
      progress.newReleases,
      message,
    );
  } finally {
    stopRequested = false;
  }

  return getProgress();
}

/* ------------------------------------------------------ artist identity */

async function identifyArtist(artist: ArtistRow): Promise<void> {
  let candidates: MbCandidate[];
  try {
    candidates = await searchArtist(artist.name);
  } catch (err) {
    store.setArtistError(artist.plex_key, (err as Error).message);
    return;
  }

  const target = normaliseArtistName(artist.name);
  const exact = candidates.filter(
    (c) => c.score >= 85 && normaliseArtistName(c.name) === target,
  );

  if (exact.length === 0) {
    store.setArtistMbid(artist.plex_key, null, 'not_found');
    return;
  }
  if (exact.length === 1) {
    store.setArtistMbid(artist.plex_key, exact[0]!.id, 'resolved');
    return;
  }

  // Several real artists share this name. Let the library break the tie: the
  // right one is whoever released the albums already sitting in Plex.
  const owned = store.ownedTitles(artist.plex_key);
  if (owned.size > 0) {
    let best: { id: string; score: number } | null = null;
    for (const candidate of exact.slice(0, 3)) {
      try {
        const groups = await browseReleaseGroups(candidate.id);
        const titles = new Set(groups.map((g) => normaliseTitle(g.title)));
        const score = titleOverlap(owned, titles);
        if (!best || score > best.score) best = { id: candidate.id, score };
      } catch {
        // A failed candidate simply does not win the tie-break.
      }
    }
    if (best && best.score > 0) {
      store.setArtistMbid(artist.plex_key, best.id, 'resolved');
      return;
    }
  }

  store.setArtistCandidates(artist.plex_key, exact.slice(0, 5));
}

/* ----------------------------------------------------------- release check */

function wantedTypes(settings: Record<string, string>): Set<string> {
  const wanted = new Set<string>();
  if (settings.include_album === '1') wanted.add('album');
  if (settings.include_ep === '1') wanted.add('ep');
  if (settings.include_single === '1') wanted.add('single');
  return wanted;
}

async function checkArtistReleases(artist: ArtistRow, wanted: Set<string>): Promise<number> {
  if (!artist.mbid) return 0;
  const groups = await browseReleaseGroups(artist.mbid);
  const owned = store.ownedTitles(artist.plex_key);
  let newCount = 0;

  for (const group of groups) {
    if (!isWanted(group, wanted)) continue;
    const norm = normaliseTitle(group.title);
    const isNew = store.upsertRelease({
      mb_id: group.id,
      plex_key: artist.plex_key,
      title: group.title,
      norm_title: norm,
      primary_type: group.primaryType,
      secondary_types: group.secondaryTypes.length ? group.secondaryTypes.join(', ') : null,
      release_date: group.firstReleaseDate,
      owned: owned.has(norm),
    });
    if (isNew && !owned.has(norm) && isCurrent(group.firstReleaseDate)) newCount += 1;
  }
  return newCount;
}

function isWanted(group: MbReleaseGroup, wanted: Set<string>): boolean {
  if (group.secondaryTypes.length > 0) return false; // live, compilation, remix, soundtrack
  const primary = (group.primaryType ?? '').toLowerCase();
  return wanted.has(primary);
}

/** Recent or future. Used only to decide whether a find is worth counting. */
function isCurrent(date: string | null): boolean {
  if (!date) return false;
  const recentDays = Number(store.getSetting('recent_days')) || 180;
  return date >= daysAgo(recentDays);
}


/**
 * The quick pass, sharing the scan's progress object so it shows in the same
 * strip and cannot run at the same time as a full scan.
 */
export async function runRefresh(parts?: RefreshPart[]): Promise<Progress> {
  if (progress.running) return getProgress();
  if (!store.isConfigured()) {
    Object.assign(progress, {
      phase: 'failed',
      message: 'Plex is not configured yet. Open Settings and add your server URL and token.',
    });
    return getProgress();
  }

  Object.assign(progress, {
    running: true,
    phase: 'refresh',
    done: 0,
    total: 0,
    current: '',
    message: 'Refreshing',
    newReleases: 0,
    startedAt: nowIso(),
    finishedAt: null,
  });

  try {
    const result = await refreshLibraryState((m) => {
      progress.current = m;
    }, parts);
    Object.assign(progress, {
      running: false,
      phase: 'done',
      current: '',
      finishedAt: nowIso(),
      message: result.message,
    });
  } catch (err) {
    Object.assign(progress, {
      running: false,
      phase: 'failed',
      current: '',
      finishedAt: nowIso(),
      message: `Refresh failed: ${(err as Error).message}`,
    });
  }
  return getProgress();
}
