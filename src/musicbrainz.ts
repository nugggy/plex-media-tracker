import { USER_AGENT } from './config.ts';
import type { MbCandidate } from './db.ts';

const API = 'https://musicbrainz.org/ws/2';

/**
 * MusicBrainz allows roughly one request per second per client. Every call in
 * the app funnels through this queue, so the limit cannot be broken by adding a
 * caller somewhere else.
 */
const MIN_GAP_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function schedule<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return job();
  });
  // Keep the chain alive even when a job rejects.
  chain = run.catch(() => undefined);
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MusicBrainzError extends Error {}

async function mbFetch<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('fmt', 'json');

  const attempt = async (): Promise<T> => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 503 || res.status === 429) {
      throw new MusicBrainzError('rate-limited');
    }
    if (res.status === 404) {
      throw new MusicBrainzError('Not found in MusicBrainz');
    }
    if (!res.ok) {
      throw new MusicBrainzError(`MusicBrainz returned HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  };

  let lastError: unknown;
  for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
    try {
      return await schedule(attempt);
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof MusicBrainzError
          ? err.message === 'rate-limited'
          : true; // network and timeout errors are worth another go
      if (!retryable) break;
      await sleep(2000 * (tryNumber + 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MusicBrainzError('MusicBrainz request failed');
}

/* ------------------------------------------------------------ artist search */

interface MbArtistSearchResponse {
  artists?: {
    id: string;
    name: string;
    score?: number;
    disambiguation?: string;
    area?: { name?: string };
    country?: string;
  }[];
}

export async function searchArtist(name: string): Promise<MbCandidate[]> {
  const data = await mbFetch<MbArtistSearchResponse>('/artist', {
    query: `artist:"${name.replace(/"/g, '')}"`,
    limit: '10',
  });
  return (data.artists ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    score: a.score ?? 0,
    disambiguation: a.disambiguation ?? '',
    area: a.area?.name ?? a.country ?? '',
  }));
}

/* ------------------------------------------------------- release group browse */

export interface MbReleaseGroup {
  id: string;
  title: string;
  primaryType: string | null;
  secondaryTypes: string[];
  firstReleaseDate: string | null;
}

interface MbBrowseResponse {
  'release-groups'?: {
    id: string;
    title: string;
    'primary-type'?: string | null;
    'secondary-types'?: string[];
    'first-release-date'?: string;
  }[];
  'release-group-count'?: number;
}

/**
 * Every release group credited to an artist. Paged, because prolific artists
 * comfortably exceed a single page.
 */
export async function browseReleaseGroups(artistMbid: string): Promise<MbReleaseGroup[]> {
  const limit = 100;
  const out: MbReleaseGroup[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await mbFetch<MbBrowseResponse>('/release-group', {
      artist: artistMbid,
      limit: String(limit),
      offset: String(offset),
    });
    total = data['release-group-count'] ?? 0;
    const batch = data['release-groups'] ?? [];
    for (const rg of batch) {
      out.push({
        id: rg.id,
        title: rg.title,
        primaryType: rg['primary-type'] ?? null,
        secondaryTypes: rg['secondary-types'] ?? [],
        firstReleaseDate: normaliseDate(rg['first-release-date']),
      });
    }
    if (batch.length === 0) break;
    offset += batch.length;
    if (offset > 2000) break; // sanity cap
  }
  return out;
}

/**
 * MusicBrainz dates can be a year, a year-month, or a full date. Pad partials
 * out so string comparison against an ISO date still behaves.
 */
function normaliseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return null;
}

/* --------------------------------------------------------- artist lookup */

/**
 * Everything MusicBrainz holds about one artist, in a single call.
 *
 * The three inc values are what the Suggestions tab needs and no more:
 * url-rels carries the Wikidata link that leads to a photograph, tags give
 * the genre, and aliases is deliberately left off because nothing reads it.
 * Going through mbFetch keeps this inside the one-a-second queue with every
 * other call, which matters when a suggestions build asks about a hundred
 * artists in a row.
 */
export async function lookupArtistDetail(mbid: string): Promise<unknown> {
  return mbFetch<unknown>(`/artist/${encodeURIComponent(mbid)}`, { inc: 'url-rels+tags' });
}
