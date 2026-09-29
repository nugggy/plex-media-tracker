import { mbidFromGuid, normaliseTitle } from './matching.ts';

export interface PlexSection {
  key: string;
  title: string;
  type: string;
}

export interface PlexArtist {
  plex_key: string;
  name: string;
  sort_name: string;
  thumb: string | null;
  mbid: string | null;
}

export interface PlexAlbum {
  plex_key: string;
  artist_key: string;
  title: string;
  norm_title: string;
  year: number | null;
}

export class PlexError extends Error {
  /** The HTTP status Plex answered with, when it answered at all. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Nothing answered at the address, as opposed to Plex answering with an error. */
export class PlexUnreachable extends PlexError {}

export interface LibraryEntry {
  guid: string;
  rating_key: string | null;
  type: string;
  title: string;
  year: number | null;
  file_count: number;
  resolution: string | null;
  codec: string | null;
  size: number | null;
}

interface PlexMetadata {
  key?: string;
  type?: string;
  ratingKey?: string;
  parentRatingKey?: string;
  title?: string;
  titleSort?: string;
  thumb?: string;
  guid?: string;
  year?: number;
  Guid?: { id?: string }[];
  Media?: {
    videoResolution?: string;
    videoCodec?: string;
    Part?: { size?: number; Stream?: { streamType?: number }[] }[];
  }[];
}

export interface PlexContainer {
  MediaContainer?: {
    Directory?: PlexMetadata[];
    Metadata?: PlexMetadata[];
    size?: number;
    totalSize?: number;
  };
}

function cleanBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

export async function plexGet(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<PlexContainer> {
  const url = new URL(cleanBaseUrl(baseUrl) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('X-Plex-Token', token);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    const cause = timedOut
      ? 'It did not answer in time.'
      : 'Nothing answered at that address.';
    throw new PlexUnreachable(
      `Could not reach Plex at ${cleanBaseUrl(baseUrl)}. ${cause} Check the address and port, and that the server is switched on. Away from home, choose Find my server automatically in Settings.`,
    );
  }

  if (res.status === 401) {
    throw new PlexError('Plex rejected the token. Check the X-Plex-Token value in Settings.', 401);
  }
  if (!res.ok) {
    throw new PlexError(`Plex returned HTTP ${res.status} for ${path}`, res.status);
  }
  return (await res.json()) as PlexContainer;
}

async function listSections(
  baseUrl: string,
  token: string,
  wanted: string[],
): Promise<PlexSection[]> {
  const data = await plexGet(baseUrl, token, '/library/sections');
  const dirs = data.MediaContainer?.Directory ?? [];
  return dirs
    .filter((d) => wanted.includes(d.type ?? ''))
    .map((d) => ({
      key: String(d.key ?? ''),
      title: d.title ?? 'Library',
      type: d.type ?? '',
    }))
    .filter((s) => s.key !== '');
}

export async function listMusicSections(baseUrl: string, token: string): Promise<PlexSection[]> {
  return listSections(baseUrl, token, ['artist']);
}

/** Film and TV sections, used to tell whether a watchlist item is already held. */
export async function listVideoSections(baseUrl: string, token: string): Promise<PlexSection[]> {
  return listSections(baseUrl, token, ['movie', 'show']);
}

/**
 * Every plex:// GUID held in the local film and TV sections. The watchlist uses
 * the same GUIDs, so membership is an exact match rather than a title guess.
 */
export async function fetchLibraryGuids(
  baseUrl: string,
  token: string,
  sections: PlexSection[],
): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  for (const section of sections) {
    const plexType = section.type === 'movie' ? '1' : '2';
    const items = await listSectionItems(baseUrl, token, section.key, plexType);
    for (const item of items) {
      if (!item.guid || !item.guid.startsWith('plex://')) continue;
      const media = item.Media ?? [];
      out.push({
        guid: item.guid,
        rating_key: item.ratingKey ? String(item.ratingKey) : null,
        type: section.type,
        title: String(item.title ?? ''),
        year: typeof item.year === 'number' ? item.year : null,
        // More than one Media entry means more than one file for the same thing.
        file_count: media.length,
        resolution: media[0]?.videoResolution ?? null,
        codec: media[0]?.videoCodec ?? null,
        size: media[0]?.Part?.[0]?.size ?? null,
      });
    }
  }
  return out;
}

/** Pages through a library section. Plex caps a response at
 *  whatever the container size is, so we walk it explicitly. */
async function listSectionItems(
  baseUrl: string,
  token: string,
  sectionKey: string,
  type: string,
): Promise<PlexMetadata[]> {
  const pageSize = 500;
  const out: PlexMetadata[] = [];
  let start = 0;

  for (;;) {
    const data = await plexGet(baseUrl, token, `/library/sections/${sectionKey}/all`, {
      type,
      includeGuids: '1',
      'X-Plex-Container-Start': String(start),
      'X-Plex-Container-Size': String(pageSize),
    });
    const batch = data.MediaContainer?.Metadata ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break;
    start += pageSize;
    if (start > 200_000) break; // hard stop, something is wrong
  }
  return out;
}

function extractMbid(item: PlexMetadata): string | null {
  const direct = mbidFromGuid(item.guid);
  if (direct) return direct;
  for (const g of item.Guid ?? []) {
    const found = mbidFromGuid(g.id);
    if (found) return found;
  }
  return null;
}

export async function fetchArtists(
  baseUrl: string,
  token: string,
  sectionKey: string,
): Promise<PlexArtist[]> {
  const items = await listSectionItems(baseUrl, token, sectionKey, '8');
  return items
    .filter((i) => i.ratingKey && i.title)
    .map((i) => ({
      plex_key: String(i.ratingKey),
      name: String(i.title),
      sort_name: String(i.titleSort ?? i.title),
      thumb: i.thumb ?? null,
      mbid: extractMbid(i),
    }));
}

export async function fetchAlbums(
  baseUrl: string,
  token: string,
  sectionKey: string,
): Promise<PlexAlbum[]> {
  const items = await listSectionItems(baseUrl, token, sectionKey, '9');
  return items
    .filter((i) => i.ratingKey && i.parentRatingKey && i.title)
    .map((i) => ({
      plex_key: String(i.ratingKey),
      artist_key: String(i.parentRatingKey),
      title: String(i.title),
      norm_title: normaliseTitle(String(i.title)),
      year: typeof i.year === 'number' ? i.year : null,
    }));
}

export interface PlexTrack {
  rating_key: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  /** True when Plex carries a lyrics stream (type 4, lrc or txt) for the track. */
  covered: boolean;
}

interface TrackMetadata extends PlexMetadata {
  grandparentTitle?: string;
  parentTitle?: string;
  duration?: number;
}

/** True when the item carries a lyrics stream (type 4, an lrc or txt sidecar). */
export function hasLyricsStream(item: Pick<PlexMetadata, 'Media'>): boolean {
  return (item.Media ?? []).some((m) =>
    (m.Part ?? []).some((p) => (p.Stream ?? []).some((s) => s.streamType === 4)),
  );
}

/** How many tracks one metadata request asks for. 173 keys answered in a third of a second. */
const STREAM_BATCH = 100;

/**
 * The tracks under one artist, one album, or a whole music library, with
 * whether Plex already has lyrics for each.
 *
 * Checked against the real server on 29/09/2026: the list endpoints (an
 * album's children, an artist's or a section's allLeaves) leave the streams
 * out, whatever include parameter is sent, so a list alone cannot say whether
 * a track has lyrics. A metadata request for several keys at once,
 * /library/metadata/1,2,3, does carry them, so the list supplies the keys and
 * batched metadata requests supply the streams. A library of 1,270 tracks is
 * thirteen requests.
 */
export async function fetchTracks(
  baseUrl: string,
  token: string,
  key: string,
  kind: 'artist' | 'album' | 'library',
): Promise<PlexTrack[]> {
  const items =
    kind === 'library'
      ? await listSectionLeaves(baseUrl, token, key)
      : (((await plexGet(
          baseUrl,
          token,
          `/library/metadata/${key}/${kind === 'artist' ? 'allLeaves' : 'children'}`,
        )).MediaContainer?.Metadata ?? []) as TrackMetadata[]);
  const tracks = items.filter((i) => i.type === 'track' && i.ratingKey && i.title);

  const covered = new Set<string>();
  for (let i = 0; i < tracks.length; i += STREAM_BATCH) {
    const keys = tracks.slice(i, i + STREAM_BATCH).map((t) => String(t.ratingKey));
    const data = await plexGet(baseUrl, token, `/library/metadata/${keys.join(',')}`);
    for (const item of data.MediaContainer?.Metadata ?? []) {
      if (item.ratingKey && hasLyricsStream(item)) covered.add(String(item.ratingKey));
    }
  }

  return tracks.map((i) => ({
    rating_key: String(i.ratingKey),
    title: String(i.title),
    artist: String(i.grandparentTitle ?? ''),
    album: i.parentTitle ?? null,
    duration_ms: typeof i.duration === 'number' ? i.duration : null,
    covered: covered.has(String(i.ratingKey)),
  }));
}

/** Every track in a music library, paged the way listSectionItems pages. */
async function listSectionLeaves(
  baseUrl: string,
  token: string,
  sectionKey: string,
): Promise<TrackMetadata[]> {
  const pageSize = 500;
  const out: TrackMetadata[] = [];
  let start = 0;
  for (;;) {
    const data = await plexGet(baseUrl, token, `/library/sections/${sectionKey}/allLeaves`, {
      'X-Plex-Container-Start': String(start),
      'X-Plex-Container-Size': String(pageSize),
    });
    const batch = (data.MediaContainer?.Metadata ?? []) as TrackMetadata[];
    out.push(...batch);
    if (batch.length < pageSize) break;
    start += pageSize;
    if (start > 200_000) break; // hard stop, something is wrong
  }
  return out;
}

export interface PlexTestResult {
  ok: boolean;
  message: string;
  sections: PlexSection[];
  serverName?: string;
}

export async function testConnection(baseUrl: string, token: string): Promise<PlexTestResult> {
  try {
    const root = await plexGet(baseUrl, token, '/');
    const serverName =
      (root.MediaContainer as { friendlyName?: string } | undefined)?.friendlyName ?? 'Plex';
    const sections = await listMusicSections(baseUrl, token);
    if (sections.length === 0) {
      return { ok: false, message: 'Connected, but no music libraries were found.', sections: [] };
    }
    return {
      ok: true,
      message: `Connected to ${serverName}. Found ${sections.length} music ${
        sections.length === 1 ? 'library' : 'libraries'
      }.`,
      sections,
      serverName,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message, sections: [] };
  }
}

/** Builds a URL that proxies a Plex thumbnail through the Plex server. */
export function thumbUrl(baseUrl: string, token: string, thumb: string | null): string | null {
  if (!thumb) return null;
  return `${cleanBaseUrl(baseUrl)}${thumb}${thumb.includes('?') ? '&' : '?'}X-Plex-Token=${encodeURIComponent(token)}`;
}
