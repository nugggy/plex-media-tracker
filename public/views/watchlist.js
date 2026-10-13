/**
 * Following, Watchlist: the Plex watchlist, and the shows on the server
 * that nobody is tracking.
 */

import { cmp, fold, plural, formatDate } from '../feed.js';
import { $, banner, el, safeHref } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import {
  addToWatchlistButton,
  artwork,
  releaseArtwork,
  togglePlayer,
  wireChips,
} from '../components.js';
import { refreshState } from './status.js';

/* ------------------------------------------------------------- watchlist */

export async function loadWatchlist() {
  try {
    const { items, removals } = await api('/api/watchlist');
    state.watchlist = items;
    state.removals = removals;
    renderWatchlist();
  } catch (err) {
    banner(err.message);
  }
}

const WL_SORTS = {
  title: (a, b) => cmp(a.title, b.title),
  added: (a, b) => cmp(b.added_at ?? '', a.added_at ?? ''),
  date: (a, b) => cmp(b.release_date ?? '', a.release_date ?? ''),
};

function renderWatchlist() {
  const f = state.wlFilters;
  const q = fold(f.q).trim();
  const listed = state.watchlist.filter((i) => i.state === 'listed');
  const rows = listed
    .filter((i) => f.types.has(i.type))
    .filter((i) => !q || fold(i.title).includes(q))
    .sort(WL_SORTS[f.sort]);

  const active = q !== '' || f.types.size !== 2 || f.sort !== 'title';
  $('#wl-summary').textContent =
    listed.length === 0
      ? ''
      : active
        ? `Showing ${rows.length} of ${plural(listed.length, 'item')}`
        : plural(listed.length, 'item');

  const undo = $('#wl-undo');
  undo.hidden = state.removals.length === 0;
  if (state.removals.length) undo.textContent = `Undo removing ${state.removals[0].title}`;

  const list = $('#wl-list');
  releaseArtwork(list);
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, listed.length === 0 ? 'Nothing here yet' : 'Nothing matches'),
        listed.length === 0 ? 'Press Sync watchlist to pull it from Plex.' : '',
      ),
    );
    return;
  }
  for (const item of rows) list.append(watchlistRow(item));
}

function watchlistRow(item) {
  const sub = [
    item.year,
    item.type === 'show' && item.season_count ? plural(item.season_count, 'season') : null,
    item.in_library ? 'in your library' : null,
    item.release_date ? formatDate(item.release_date) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const row = el('div', { class: 'artist-row' });
  row.append(
    artwork(item.thumb_url, item.title),
    el(
      'div',
      {},
      el('div', { class: 'artist-name' }, item.title),
      el('div', { class: 'artist-sub' }, sub),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el('span', { class: 'tag' }, item.type === 'movie' ? 'film' : 'show'),
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: () =>
            togglePlayer(
              {
                kind: item.type,
                title: item.title,
                subtitle: '',
                year: item.year,
              },
              row,
            ),
        },
        'Trailer',
      ),
      safeHref(item.public_url)
        ? el(
            'a',
            { class: 'link', href: safeHref(item.public_url), target: '_blank', rel: 'noreferrer' },
            'Plex',
          )
        : null,
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: async (e) => {
            // currentTarget is cleared once the handler yields, so hold on to the button.
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await post('/api/watchlist/remove', { rating_key: item.rating_key });
              banner(`${item.title} removed from your Plex watchlist.`, 'ok');
              loadWatchlist();
              refreshState();
            } catch (err) {
              banner(err.message);
              btn.disabled = false;
            }
          },
        },
        'Remove',
      ),
    ),
  );
  return row;
}

$('#wl-filter').addEventListener('input', (e) => {
  state.wlFilters.q = e.target.value;
  renderWatchlist();
});

$('#wl-sort').addEventListener('change', (e) => {
  state.wlFilters.sort = e.target.value;
  renderWatchlist();
});

wireChips('#wl-chips', 'wl', () => state.wlFilters.types, renderWatchlist);
$('#wl-undo').addEventListener('click', async (e) => {
  const last = state.removals[0];
  if (!last) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await post('/api/watchlist/restore', { rating_key: last.rating_key });
    banner(`${last.title} put back on your Plex watchlist.`, 'ok');
    loadWatchlist();
    refreshState();
  } catch (err) {
    banner(err.message);
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------- shows held but not on the watchlist */

/**
 * A show can sit on the server for years without the app knowing an episode is
 * due, because episode tracking follows the watchlist rather than the library.
 * This lists the gap so it can be closed one show at a time.
 */
export async function loadGaps() {
  try {
    const { shows } = await api('/api/watchlist/gaps');
    state.gaps = shows;
    renderGaps();
  } catch {
    // The gap list is a convenience; failing to build it must not break the tab.
    $('#gaps-card').hidden = true;
  }
}

function renderGaps() {
  const card = $('#gaps-card');
  const all = state.gaps ?? [];
  if (all.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const q = fold($('#gaps-filter').value).trim();
  const rows = all.filter((g) => !q || fold(g.title).includes(q));

  $('#gaps-title').textContent =
    `Shows on your server you are not tracking (${all.length})`;

  const list = $('#gaps-list');
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(el('div', { class: 'empty' }, el('strong', {}, 'Nothing matches')));
    return;
  }
  for (const g of rows.slice(0, 200)) list.append(gapRow(g));
  if (rows.length > 200) {
    list.append(
      el('p', { class: 'muted small' }, `Showing the first 200 of ${rows.length}. Filter to narrow.`),
    );
  }
}

function gapRow(g) {
  return el(
    'div',
    { class: 'artist-row' },
    el('div', { class: 'art art-fallback' }, (g.title || '?').charAt(0).toUpperCase()),
    el(
      'div',
      {},
      el('div', { class: 'artist-name' }, g.title),
      el('div', { class: 'artist-sub' }, [g.year, 'on your server, not tracked'].filter(Boolean).join(' · ')),
    ),
    el(
      'div',
      { class: 'card-actions' },
      addToWatchlistButton({
        label: 'Track',
        payload: { kind: 'show', id: g.rating_key, title: g.title },
        message: `${g.title} added to your Plex watchlist.`,
        onAdded: () => {
          state.gaps = (state.gaps ?? []).filter((x) => x.rating_key !== g.rating_key);
          renderGaps();
        },
      }),
    ),
  );
}

$('#gaps-filter').addEventListener('input', renderGaps);
