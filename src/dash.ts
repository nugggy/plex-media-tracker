/**
 * The Dashboard tab: what is playing right now, what the server holds, what
 * came in lately, and what has been watched. Everything here is read live from
 * the Plex server when the tab asks, and none of it is stored, so it is never
 * stale and never needs a check to fill it.
 *
 * Now playing and history are server-owner views in Plex. A token from a
 * shared user is refused, and the error says so rather than blaming the token.
 */
import * as store from './db.ts';
import { withPlex } from './plexconnect.ts';
import { plexGet, PlexError } from './plex.ts';

/* ------------------------------------------------------------ raw shapes */

interface RawItem {
  sessionKey?: string;
  ratingKey?: string;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
  duration?: number;
  viewOffset?: number;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  addedAt?: number;
  viewedAt?: number;
  accountID?: number;
  deviceID?: number;
  leafCount?: number;
  User?: { id?: string; title?: string };
  Player?: { title?: string; product?: string; platform?: string; state?: string; local?: boolean };
  Session?: { id?: string; bandwidth?: number; location?: string };
  TranscodeSession?: { videoDecision?: string; audioDecision?: string; throttled?: boolean };
  Media?: { videoResolution?: string; bitrate?: number; audioCodec?: string }[];
}

/** Plex's own shape, with the fields the sessions and history endpoints add. */
interface Container {
  MediaContainer?: {
    Metadata?: RawItem[];
    Account?: { id?: number; name?: string }[];
    Device?: { id?: number; name?: string; platform?: string }[];
  };
}

/* ------------------------------------------------------------ now playing */

export interface Stream {
  session_id: string | null;
  kind: string;
  title: string;
  subtitle: string;
  user: string;
  player: string;
  platform: string;
  state: string;
  decision: 'Direct play' | 'Direct stream' | 'Transcode';
  quality: string | null;
  local: boolean;
  bandwidth_kbps: number;
  progress: number;
  position_ms: number;
  duration_ms: number;
  thumb: string | null;
}

/** Episode and track titles read better with the show or artist first. */
function describe(m: RawItem): { title: string; subtitle: string } {
  if (m.type === 'episode') {
    const se =
      m.parentIndex != null && m.index != null
        ? `S${String(m.parentIndex).padStart(2, '0')}E${String(m.index).padStart(2, '0')} · `
        : '';
    return { title: m.grandparentTitle ?? m.title ?? '', subtitle: `${se}${m.title ?? ''}` };
  }
  if (m.type === 'track') {
    return {
      title: m.title ?? '',
      subtitle: [m.grandparentTitle, m.parentTitle].filter(Boolean).join(' · '),
    };
  }
  if (m.type === 'season') {
    return { title: m.parentTitle ?? '', subtitle: m.title ?? '' };
  }
  if (m.type === 'album') {
    return { title: m.title ?? '', subtitle: m.parentTitle ?? '' };
  }
  return { title: m.title ?? '', subtitle: m.year ? String(m.year) : '' };
}

/** The poster that suits the thing: the show's for an episode, the album's for a track. */
function posterOf(m: RawItem): string | null {
  if (m.type === 'episode') return m.grandparentThumb ?? m.thumb ?? null;
  if (m.type === 'track') return m.parentThumb ?? m.thumb ?? null;
  return m.thumb ?? null;
}

function decisionOf(m: RawItem): Stream['decision'] {
  const t = m.TranscodeSession;
  if (!t) return 'Direct play';
  const decisions = [t.videoDecision, t.audioDecision];
  if (decisions.includes('transcode')) return 'Transcode';
  if (decisions.includes('copy')) return 'Direct stream';
  return 'Direct play';
}

const RES: Record<string, string> = { sd: 'SD', '4k': '4K' };

export function parseSessions(data: Container): Stream[] {
  return (data.MediaContainer?.Metadata ?? []).map((m) => {
    const media = m.Media?.[0];
    const res = media?.videoResolution;
    const quality = res ? (RES[res] ?? (/p$/i.test(res) ? res : `${res}p`)) : media?.audioCodec ? media.audioCodec.toUpperCase() : null;
    const duration = m.duration ?? 0;
    const position = m.viewOffset ?? 0;
    return {
      session_id: m.Session?.id ?? null,
      kind: m.type ?? 'unknown',
      ...describe(m),
      user: m.User?.title ?? 'Someone',
      player: m.Player?.title || m.Player?.product || 'Unknown player',
      platform: m.Player?.platform ?? '',
      state: m.Player?.state ?? 'playing',
      decision: decisionOf(m),
      quality,
      local: m.Player?.local ?? m.Session?.location === 'lan',
      bandwidth_kbps: m.Session?.bandwidth ?? 0,
      progress: duration > 0 ? Math.min(1, position / duration) : 0,
      position_ms: position,
      duration_ms: duration,
      thumb: posterOf(m),
    };
  });
}

/* --------------------------------------------------------------- history */

export interface Play {
  title: string;
  subtitle: string;
  kind: string;
  /** What the play counts towards in the charts: the show, not the episode. */
  group: string;
  user: string;
  platform: string;
  viewed_at: number;
  thumb: string | null;
}

export interface Ranked {
  label: string;
  plays: number;
}

export interface HistorySummary {
  days: number;
  plays: number;
  users: number;
  titles: number;
  top_titles: Ranked[];
  top_users: Ranked[];
  top_platforms: Ranked[];
  by_kind: Ranked[];
  recent: Play[];
  truncated: boolean;
}

const KIND_LABEL: Record<string, string> = { movie: 'Films', episode: 'Episodes', track: 'Music' };

export function parseHistory(
  rows: RawItem[],
  accounts: Map<number, string>,
  devices: Map<number, string>,
): Play[] {
  return rows.map((m) => {
    const d = describe(m);
    return {
      ...d,
      kind: m.type ?? 'unknown',
      group: m.type === 'episode' ? (m.grandparentTitle ?? d.title) : m.type === 'track' ? (m.grandparentTitle ?? d.title) : d.title,
      user: accounts.get(m.accountID ?? -1) ?? 'Unknown user',
      platform: devices.get(m.deviceID ?? -1) ?? 'Unknown device',
      viewed_at: m.viewedAt ?? 0,
      thumb: posterOf(m),
    };
  });
}

function rank(values: string[], limit = 10): Ranked[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([label, plays]) => ({ label, plays }))
    .sort((a, b) => b.plays - a.plays || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function summariseHistory(plays: Play[], days: number, truncated = false): HistorySummary {
  const sorted = [...plays].sort((a, b) => b.viewed_at - a.viewed_at);
  return {
    days,
    plays: plays.length,
    users: new Set(plays.map((p) => p.user)).size,
    titles: new Set(plays.map((p) => p.group)).size,
    top_titles: rank(plays.map((p) => p.group)),
    top_users: rank(plays.map((p) => p.user)),
    top_platforms: rank(plays.map((p) => p.platform)),
    by_kind: rank(plays.map((p) => KIND_LABEL[p.kind] ?? 'Other')),
    recent: sorted.slice(0, 25),
    truncated,
  };
}

/* ---------------------------------------------------------------- stats */

export interface LibraryStat {
  key: string;
  title: string;
  type: string;
  counts: Ranked[];
}

/** What each kind of library is counted in, biggest unit first. */
const COUNT_TYPES: Record<string, [string, string][]> = {
  movie: [['1', 'films']],
  show: [['2', 'shows'], ['3', 'seasons'], ['4', 'episodes']],
  artist: [['8', 'artists'], ['9', 'albums'], ['10', 'tracks']],
  photo: [['13', 'photos']],
};

export interface Added {
  title: string;
  subtitle: string;
  kind: string;
  added_at: number;
  rating_key: string | null;
  thumb: string | null;
}

export function parseRecentlyAdded(data: Container): Added[] {
  return (data.MediaContainer?.Metadata ?? []).map((m) => ({
    ...describe(m),
    kind: m.type ?? 'unknown',
    added_at: m.addedAt ?? 0,
    rating_key: m.ratingKey ?? null,
    thumb: m.thumb ?? m.parentThumb ?? null,
  }));
}

/* --------------------------------------------------------------- fetches */

function token(): string {
  return store.getSetting('plex_token');
}

/** A refusal here means a shared user's token, not a wrong one. */
function ownerOnly<T>(what: string, work: () => Promise<T>): Promise<T> {
  return work().catch((err: unknown) => {
    if (err instanceof PlexError && (err.status === 401 || err.status === 403)) {
      throw new PlexError(
        `Plex would not show ${what} for this token. Only the server owner's token can see it.`,
        err.status,
      );
    }
    throw err;
  });
}

export async function nowPlaying(): Promise<{ streams: Stream[]; bandwidth_kbps: number }> {
  const streams = await ownerOnly('who is playing', () =>
    withPlex(async (url) => parseSessions((await plexGet(url, token(), '/status/sessions')) as Container)),
  );
  return { streams, bandwidth_kbps: streams.reduce((n, s) => n + s.bandwidth_kbps, 0) };
}

export async function stopStream(sessionId: string, reason: string): Promise<void> {
  await ownerOnly('stop a stream', () =>
    withPlex((url) =>
      plexGet(url, token(), '/status/sessions/terminate', { sessionId, reason }).catch((err) => {
        // Plex answers a terminate with an empty body, which is not JSON.
        if (err instanceof SyntaxError) return {};
        throw err;
      }),
    ),
  );
}

export async function libraryStats(): Promise<LibraryStat[]> {
  return withPlex(async (url) => {
    const sections = (await plexGet(url, token(), '/library/sections')).MediaContainer?.Directory ?? [];
    return Promise.all(
      sections.map(async (s) => {
        const type = s.type ?? '';
        const counts: Ranked[] = [];
        for (const [plexType, label] of COUNT_TYPES[type] ?? []) {
          const data = await plexGet(url, token(), `/library/sections/${s.key}/all`, {
            type: plexType,
            'X-Plex-Container-Start': '0',
            'X-Plex-Container-Size': '0',
          });
          counts.push({ label, plays: data.MediaContainer?.totalSize ?? data.MediaContainer?.size ?? 0 });
        }
        return { key: String(s.key ?? ''), title: s.title ?? 'Library', type, counts };
      }),
    );
  });
}

export async function recentlyAdded(limit = 24): Promise<Added[]> {
  return withPlex(async (url) =>
    parseRecentlyAdded(
      (await plexGet(url, token(), '/library/recentlyAdded', {
        'X-Plex-Container-Start': '0',
        'X-Plex-Container-Size': String(limit),
      })) as Container,
    ),
  );
}

/** Enough for a busy month on a family server without walking forever. */
const HISTORY_CAP = 5000;

export async function history(days: number): Promise<HistorySummary> {
  return ownerOnly('watch history', () =>
    withPlex(async (url) => {
      const since = Math.floor(Date.now() / 1000) - days * 86_400;
      const [accountsData, devicesData] = (await Promise.all([
        plexGet(url, token(), '/accounts'),
        plexGet(url, token(), '/devices'),
      ])) as Container[];
      const accounts = new Map(
        (accountsData.MediaContainer?.Account ?? []).map((a) => [a.id ?? -1, a.name || 'Owner']),
      );
      const devices = new Map(
        (devicesData.MediaContainer?.Device ?? []).map((d) => [d.id ?? -1, d.platform || d.name || 'Unknown device']),
      );

      const rows: RawItem[] = [];
      const pageSize = 500;
      for (let start = 0; start < HISTORY_CAP; start += pageSize) {
        const data = (await plexGet(url, token(), '/status/sessions/history/all', {
          sort: 'viewedAt:desc',
          'viewedAt>': String(since),
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(pageSize),
        })) as Container;
        const batch = data.MediaContainer?.Metadata ?? [];
        rows.push(...batch);
        if (batch.length < pageSize) break;
      }
      // Older servers ignore the date filter, so it is applied again here.
      const inRange = rows.filter((r) => (r.viewedAt ?? 0) >= since);
      return summariseHistory(parseHistory(inRange, accounts, devices), days, rows.length >= HISTORY_CAP);
    }),
  );
}

/* ------------------------------------------------------------- artwork */

/**
 * The page asks for Plex artwork by its path on the server. Only artwork paths
 * are accepted, so the thumbnail proxy cannot be turned into a way to call any
 * other part of the Plex API with the saved token.
 */
export function isPlexArtPath(path: string): boolean {
  return /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/.test(path);
}

/**
 * Plex keeps posters at full size, often several megabytes each, so they are
 * fetched through its own resizer at a size that suits a card.
 */
export function resizedArtPath(path: string): string {
  const q = new URLSearchParams({ width: '240', height: '360', minSize: '1', upscale: '1', url: path });
  return `/photo/:/transcode?${q}`;
}
