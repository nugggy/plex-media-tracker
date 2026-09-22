/**
 * The Plex Watchlist lives in the Plex account in the cloud, not on the local
 * server, so it has its own host and its own shapes. This module is the only
 * place that knows either.
 */

import { APP_NAME } from './config.ts';

const DISCOVER = 'https://discover.provider.plex.tv';
const METADATA = 'https://metadata.provider.plex.tv';

export class DiscoverError extends Error {}

export type WatchlistType = 'movie' | 'show';

export interface WatchlistItem {
  rating_key: string;
  guid: string;
  type: WatchlistType;
  title: string;
  year: number | null;
  thumb: string | null;
  release_date: string | null;
  last_episode_at: string | null;
  last_season_at: string | null;
  season_count: number | null;
  episode_count: number | null;
  continuing: boolean;
  public_url: string | null;
  added_at: string | null;
}

interface RawItem {
  ratingKey?: string;
  guid?: string;
  type?: string;
  title?: string;
  year?: number;
  thumb?: string;
  originallyAvailableAt?: string;
  lastEpisodeOriginallyAvailableAt?: string;
  lastSeasonOriginallyAvailableAt?: string;
  childCount?: number;
  leafCount?: number;
  isContinuingSeries?: boolean;
  publicPagesURL?: string;
  addedAt?: number;
  watchlistedAt?: number;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Token': token,
    'X-Plex-Product': APP_NAME,
    'X-Plex-Client-Identifier': 'plex-media-tracker',
  };
}

async function request(
  token: string,
  url: string,
  method: 'GET' | 'PUT' = 'GET',
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: headers(token),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new DiscoverError(
      timedOut
        ? 'Plex did not answer in time. Check your internet connection.'
        : 'Could not reach plex.tv. Check your internet connection.',
    );
  }
  if (res.status === 401) {
    throw new DiscoverError(
      'plex.tv rejected the token. The watchlist needs an account token, the same one used for the server.',
    );
  }
  if (!res.ok) {
    throw new DiscoverError(`plex.tv returned HTTP ${res.status}`);
  }
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Confirms the stored token is an account token, not only a server token. */
export async function verifyAccount(token: string): Promise<string> {
  const data = (await request(token, 'https://plex.tv/api/v2/user')) as {
    username?: string;
    title?: string;
  };
  return data.username ?? data.title ?? 'your Plex account';
}

function toDate(value: string | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function toIso(seconds: number | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

function normalise(raw: RawItem): WatchlistItem | null {
  if (!raw.ratingKey || !raw.title) return null;
  if (raw.type !== 'movie' && raw.type !== 'show') return null;
  return {
    rating_key: String(raw.ratingKey),
    guid: raw.guid ?? `plex://${raw.type}/${raw.ratingKey}`,
    type: raw.type,
    title: raw.title,
    year: typeof raw.year === 'number' ? raw.year : null,
    thumb: raw.thumb ?? null,
    release_date: toDate(raw.originallyAvailableAt),
    last_episode_at: toDate(raw.lastEpisodeOriginallyAvailableAt),
    last_season_at: toDate(raw.lastSeasonOriginallyAvailableAt),
    season_count: typeof raw.childCount === 'number' ? raw.childCount : null,
    episode_count: typeof raw.leafCount === 'number' ? raw.leafCount : null,
    continuing: raw.isContinuingSeries === true,
    public_url: raw.publicPagesURL ?? null,
    added_at: toIso(raw.watchlistedAt ?? raw.addedAt),
  };
}

/** The whole watchlist, paged 100 at a time. */
export async function fetchWatchlist(token: string): Promise<WatchlistItem[]> {
  const out: WatchlistItem[] = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const data = (await request(
      token,
      `${DISCOVER}/library/sections/watchlist/all?X-Plex-Container-Start=${start}` +
        `&X-Plex-Container-Size=100&includeUserState=1`,
    )) as { MediaContainer?: { totalSize?: number; Metadata?: RawItem[] } };

    const container = data.MediaContainer ?? {};
    total = container.totalSize ?? 0;
    const batch = container.Metadata ?? [];
    for (const raw of batch) {
      const item = normalise(raw);
      if (item) out.push(item);
    }
    if (batch.length === 0) break;
    start += batch.length;
    if (start > 20_000) break; // sanity cap
  }
  return out;
}

export async function addToWatchlist(token: string, ratingKey: string): Promise<void> {
  await request(token, `${DISCOVER}/actions/addToWatchlist?ratingKey=${ratingKey}`, 'PUT');
}

export async function removeFromWatchlist(token: string, ratingKey: string): Promise<void> {
  await request(token, `${DISCOVER}/actions/removeFromWatchlist?ratingKey=${ratingKey}`, 'PUT');
}

/** Builds the URL for a Discover poster. Kept here so the host stays in one file. */
export function posterUrl(token: string, thumb: string | null): string | null {
  if (!thumb) return null;
  if (/^https?:\/\//i.test(thumb)) {
    return `${thumb}${thumb.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}`;
  }
  return `${METADATA}${thumb}?X-Plex-Token=${encodeURIComponent(token)}`;
}
