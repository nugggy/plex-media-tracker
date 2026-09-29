import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFriends,
  fetchFriendWatchlist,
  flagItems,
  mergeAcrossFriends,
  type Gql,
} from '../src/friends.ts';

/* ---------------------------------------------------------------- friends */

test('friends come back with a display name, falling back to the username', () => {
  const friends = parseFriends({
    data: {
      allFriendsV2: [
        { user: { id: 'a1', username: 'btyna', displayName: 'Tyna' } },
        { user: { id: 'b2', username: 'china', displayName: '' } },
        { user: { id: '', username: 'nobody' } },
      ],
    },
  });
  assert.deepEqual(friends, [
    { id: 'a1', username: 'btyna', name: 'Tyna' },
    { id: 'b2', username: 'china', name: 'china' },
  ]);
});

test('a GraphQL error is reported as an error, not as an empty list', () => {
  assert.throws(
    () => parseFriends({ errors: [{ message: 'Not authorised' }] }),
    /Not authorised/,
  );
});

/* -------------------------------------------------------------- watchlist */

/** A stand-in for the community API that serves two pages. */
function pagedGql(): { gql: Gql; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const gql: Gql = async (_query, variables) => {
    calls.push(variables);
    const after = variables.after as string | null | undefined;
    if (!after) {
      return {
        data: {
          user: {
            watchlist: {
              nodes: [
                { id: 'm1', title: 'Heat', type: 'MOVIE', year: 1995 },
                { id: 's1', title: 'Severance', type: 'SHOW', year: 2022 },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
            },
          },
        },
      };
    }
    return {
      data: {
        user: {
          watchlist: {
            nodes: [{ id: 'm2', title: 'Ran', type: 'MOVIE', year: 1985 }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    };
  };
  return { gql, calls };
}

test('a watchlist is read page by page until the last one', async () => {
  const { gql, calls } = pagedGql();
  const items = await fetchFriendWatchlist(gql, 'a1');
  assert.deepEqual(
    items.map((i) => [i.rating_key, i.title, i.type, i.year]),
    [
      ['m1', 'Heat', 'movie', 1995],
      ['s1', 'Severance', 'show', 2022],
      ['m2', 'Ran', 'movie', 1985],
    ],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.after, 'c1');
  assert.equal(calls[0]!.uuid, 'a1');
});

test('a friend whose watchlist is not shared reads as empty, with the reason', async () => {
  const gql: Gql = async () => ({
    data: { user: { watchlist: null } },
    errors: [{ message: 'Watchlist is private' }],
  });
  await assert.rejects(fetchFriendWatchlist(gql, 'a1'), /Watchlist is private/);
});

/* ------------------------------------------------------------------ flags */

test('items are flagged when on my own watchlist or already on the server', () => {
  const flagged = flagItems(
    [
      { rating_key: 'm1', title: 'Heat', type: 'movie', year: 1995 },
      { rating_key: 's1', title: 'Severance', type: 'show', year: 2022 },
      { rating_key: 'm2', title: 'Ran', type: 'movie', year: 1985 },
    ],
    new Set(['s1']),
    [{ type: 'movie', title: 'Heat (Director’s Cut)', year: 1995 }],
  );
  assert.deepEqual(
    flagged.map((i) => [i.rating_key, i.on_watchlist, i.in_library]),
    [
      ['m1', false, true],
      ['s1', true, false],
      ['m2', false, false],
    ],
  );
});

test('a library match needs the same type and year, not only the title', () => {
  const flagged = flagItems(
    [{ rating_key: 'm1', title: 'Heat', type: 'movie', year: 1995 }],
    new Set(),
    [
      { type: 'show', title: 'Heat', year: 1995 },
      { type: 'movie', title: 'Heat', year: 2020 },
    ],
  );
  assert.equal(flagged[0]!.in_library, false);
});

/* ----------------------------------------------------------- all friends */

test('the same title across friends becomes one row naming each of them', () => {
  const merged = mergeAcrossFriends([
    { friend: 'Tyna', items: [{ rating_key: 'm1', title: 'Heat', type: 'movie', year: 1995 }] },
    {
      friend: 'China',
      items: [
        { rating_key: 'm1', title: 'Heat', type: 'movie', year: 1995 },
        { rating_key: 's1', title: 'Severance', type: 'show', year: 2022 },
      ],
    },
  ]);
  assert.deepEqual(
    merged.map((i) => [i.rating_key, i.friends]),
    [
      ['m1', ['Tyna', 'China']],
      ['s1', ['China']],
    ],
  );
});
