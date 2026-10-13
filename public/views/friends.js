/**
 * Discover, Friends: what Plex friends have on their watchlists.
 */

import { cmp, fold, plural } from '../feed.js';
import { $, banner, el } from '../lib/dom.js';
import { api, latest, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import { addToWatchlistButton, togglePlayer, wireChips } from '../components.js';

/* --------------------------------------------------------------- friends */

export async function loadFriends() {
  const fr = state.friends;
  if (!fr.listLoaded) {
    try {
      const { friends } = await api('/api/friends');
      $('#fr-friend').replaceChildren(
        el('option', { value: 'all' }, 'All friends'),
        ...friends.map((f) => el('option', { value: f.id }, f.name)),
      );
      fr.listLoaded = true;
    } catch (err) {
      banner(err.message);
      return;
    }
  }
  loadFriendItems();
}

async function loadFriendItems() {
  const fr = state.friends;
  // Switching friends quickly must not let a slow answer for the first one
  // land after the second.
  const current = latest('friends');
  $('#fr-summary').textContent = 'Reading watchlists from plex.tv…';
  try {
    const r = await api(`/api/friends/watchlist?${new URLSearchParams({ friend: fr.friend })}`);
    if (!current()) return;
    fr.items = r.items;
    fr.notes = r.notes;
    renderFriends();
  } catch (err) {
    if (!current()) return;
    banner(err.message);
    $('#fr-summary').textContent = '';
  }
}

function renderFriends() {
  const fr = state.friends;
  const f = fr.filters;
  const q = fold(f.q).trim();
  const rows = fr.items
    .filter((i) => f.kinds.has(i.type))
    .filter((i) => !f.hideHeld || (!i.on_watchlist && !i.in_library))
    .filter((i) => !q || fold(i.title).includes(q) || i.friends.some((n) => fold(n).includes(q)))
    // Most wanted first: a title several friends share is the strongest signal.
    .sort((a, b) => b.friends.length - a.friends.length || cmp(a.title, b.title));

  $('#fr-summary').textContent = fr.items.length
    ? `${rows.length} of ${plural(fr.items.length, 'title')}` +
      (fr.notes.length ? ` · ${fr.notes.join('; ')}` : '')
    : fr.notes.join('; ');

  const list = $('#fr-list');
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, fr.items.length ? 'Nothing matches' : 'Nothing shared'),
        fr.items.length
          ? 'Untick Hide what I have, or turn a type back on.'
          : 'No friend on your account shares a watchlist with anything in it.',
      ),
    );
    return;
  }
  for (const i of rows) list.append(friendCard(i));
}

function friendCard(i) {
  const card = el('article', { class: 'card' });
  const held = i.in_library
    ? el('span', { class: 'tag held' }, '✓ In Plex')
    : i.on_watchlist
      ? el('span', { class: 'tag held' }, '✓ On my watchlist')
      : null;
  card.append(
    el('div', { class: 'art art-fallback' }, (i.title || '?').charAt(0).toUpperCase()),
    el(
      'div',
      {},
      el('p', { class: 'card-title' }, i.title),
      el(
        'p',
        { class: 'card-artist' },
        i.friends.length === 1 ? `${i.friends[0]}'s watchlist` : `${i.friends.length} friends: ${i.friends.join(', ')}`,
      ),
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: 'tag' }, i.type === 'movie' ? 'film' : 'show'),
        i.year ? el('span', {}, String(i.year)) : null,
        held,
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: () => togglePlayer({ kind: i.type, title: i.title, year: i.year }, card),
        },
        'Trailer',
      ),
      i.on_watchlist ? null : friendAddButton(i),
    ),
  );
  return card;
}

function friendAddButton(i) {
  return addToWatchlistButton({
    label: 'Add to watchlist',
    payload: { kind: i.type, id: i.rating_key, title: i.title },
    onAdded: () => {
      i.on_watchlist = true;
      renderFriends();
    },
  });
}

$('#fr-friend').addEventListener('change', (e) => {
  state.friends.friend = e.target.value;
  loadFriendItems();
});

$('#fr-filter').addEventListener('input', (e) => {
  state.friends.filters.q = e.target.value;
  renderFriends();
});

$('#fr-hide-held').addEventListener('change', (e) => {
  state.friends.filters.hideHeld = e.target.checked;
  renderFriends();
});

wireChips('#fr-chips', 'fr', () => state.friends.filters.kinds, renderFriends);

$('#fr-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await post('/api/friends/refresh');
    state.friends.listLoaded = false;
    await loadFriends();
  } catch (err) {
    banner(err.message);
  } finally {
    btn.disabled = false;
  }
});
