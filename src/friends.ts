/**
 * Friends' watchlists, from the Plex community API. Plex shares a friend's
 * watchlist only when that friend allows it, and what it shares is the title,
 * the type and the year, paged a hundred at a time, with no artwork. This is
 * the only module that knows the GraphQL shapes.
 *
 * Checked against the real account before building: fourteen friends listed,
 * and each watchlist read with these exact queries.
 */
import { APP_NAME } from './config.ts';
import { normaliseTitle } from './matching.ts';

const COMMUNITY = 'https://community.plex.tv/api';

export interface Friend {
  id: string;
  username: string;
  name: string;
}

export interface FriendItem {
  rating_key: string;
  title: string;
  type: 'movie' | 'show';
  year: number | null;
}

export interface FlaggedItem extends FriendItem {
  on_watchlist: boolean;
  in_library: boolean;
}

export interface MergedItem extends FriendItem {
  friends: string[];
}

interface GqlResponse {
  data?: unknown;
  errors?: { message?: string }[];
}

/** One GraphQL call. Injected so the paging can be tested without a network. */
export type Gql = (query: string, variables: Record<string, unknown>) => Promise<GqlResponse>;

export function communityGql(token: string): Gql {
  return async (query, variables) => {
    const res = await fetch(COMMUNITY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Plex-Token': token,
        'X-Plex-Product': APP_NAME,
        'X-Plex-Client-Identifier': 'plex-media-tracker',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error('plex.tv rejected the token.');
    if (!res.ok) throw new Error(`plex.tv returned HTTP ${res.status}`);
    return (await res.json()) as GqlResponse;
  };
}

function firstError(r: GqlResponse): string | null {
  const e = r.errors?.[0];
  return e ? (e.message ?? 'plex.tv returned an error') : null;
}

const FRIENDS_QUERY = `query GetAllFriends {
  allFriendsV2 { user { id username displayName } }
}`;

const WATCHLIST_QUERY = `query GetWatchlistHub($uuid: ID = "", $first: PaginationInt!, $after: String) {
  user(id: $uuid) {
    watchlist(first: $first, after: $after) {
      nodes { id title type year }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function parseFriends(r: GqlResponse): Friend[] {
  const err = firstError(r);
  if (err) throw new Error(err);
  const rows = ((r.data as { allFriendsV2?: { user?: Record<string, unknown> }[] })?.allFriendsV2 ??
    []) as { user?: { id?: string; username?: string; displayName?: string } }[];
  return rows
    .map((row) => row.user ?? {})
    .filter((u) => u.id)
    .map((u) => ({
      id: String(u.id),
      username: u.username ?? '',
      name: (u.displayName ?? '').trim() || u.username || 'A friend',
    }));
}

export async function listFriends(gql: Gql): Promise<Friend[]> {
  return parseFriends(await gql(FRIENDS_QUERY, {}));
}

interface RawNode {
  id?: string;
  title?: string;
  type?: string;
  year?: number;
}

export async function fetchFriendWatchlist(gql: Gql, friendId: string): Promise<FriendItem[]> {
  const out: FriendItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const r = await gql(WATCHLIST_QUERY, { uuid: friendId, first: 100, after });
    const err = firstError(r);
    if (err) throw new Error(err);
    const list = (r.data as { user?: { watchlist?: { nodes?: RawNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null } })
      ?.user?.watchlist;
    if (!list) break;
    for (const n of list.nodes ?? []) {
      const type = n.type === 'MOVIE' ? 'movie' : n.type === 'SHOW' ? 'show' : null;
      if (!n.id || !n.title || !type) continue;
      out.push({
        rating_key: String(n.id),
        title: n.title,
        type,
        year: typeof n.year === 'number' ? n.year : null,
      });
    }
    if (!list.pageInfo?.hasNextPage || !list.pageInfo.endCursor) break;
    after = list.pageInfo.endCursor;
  }
  return out;
}

/**
 * On my watchlist is an exact match on the Discover key. In Plex is a match
 * on type, title and year against what the last library read found, since
 * a friend's item carries no Plex GUID to match exactly.
 */
export function flagItems<T extends FriendItem>(
  items: T[],
  myKeys: Set<string>,
  library: { type: string; title: string; year: number | null }[],
): (T & FlaggedItem)[] {
  const held = new Set(library.map((l) => `${l.type}|${normaliseTitle(l.title)}|${l.year ?? ''}`));
  return items.map((i) => ({
    ...i,
    on_watchlist: myKeys.has(i.rating_key),
    in_library: held.has(`${i.type}|${normaliseTitle(i.title)}|${i.year ?? ''}`),
  }));
}

/** One row per title, naming every friend who has it, in the order first seen. */
export function mergeAcrossFriends(lists: { friend: string; items: FriendItem[] }[]): MergedItem[] {
  const byKey = new Map<string, MergedItem>();
  for (const { friend, items } of lists) {
    for (const item of items) {
      const row = byKey.get(item.rating_key);
      if (row) {
        if (!row.friends.includes(friend)) row.friends.push(friend);
      } else {
        byKey.set(item.rating_key, { ...item, friends: [friend] });
      }
    }
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ cache */

/** Friends change rarely; a watchlist a little more often. Both are cheap to re-ask. */
const FRIENDS_TTL_MS = 60 * 60_000;
const WATCHLIST_TTL_MS = 30 * 60_000;

let friendsCache: { at: number; friends: Friend[] } | null = null;
const watchlistCache = new Map<string, { at: number; items: FriendItem[] }>();

export function clearFriendCache(): void {
  friendsCache = null;
  watchlistCache.clear();
}

export async function cachedFriends(gql: Gql, now = Date.now()): Promise<Friend[]> {
  if (friendsCache && now - friendsCache.at < FRIENDS_TTL_MS) return friendsCache.friends;
  const friends = await listFriends(gql);
  friendsCache = { at: now, friends };
  return friends;
}

export async function cachedWatchlist(gql: Gql, friendId: string, now = Date.now()): Promise<FriendItem[]> {
  const hit = watchlistCache.get(friendId);
  if (hit && now - hit.at < WATCHLIST_TTL_MS) return hit.items;
  const items = await fetchFriendWatchlist(gql, friendId);
  watchlistCache.set(friendId, { at: now, items });
  return items;
}
