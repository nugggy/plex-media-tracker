/**
 * Discover, Search.
 */

import { KIND_TAG, plural } from '../feed.js';
import { $, $$, el } from '../lib/dom.js';
import { api, latest } from '../lib/api.js';
import { state } from '../lib/state.js';
import {
  addToWatchlistButton,
  artwork,
  releaseArtwork,
  togglePlayer,
  wireChips,
} from '../components.js';

/* ---------------------------------------------------------------- search */

async function runSearch() {
  const q = $('#search-box').value.trim();
  if (q.length < 2) {
    // Anything still on its way is for an older question.
    latest('search');
    state.searchBusy = false;
    state.searchHits = [];
    state.searchNotes = ['Type at least two characters.'];
    renderSearch();
    return;
  }
  if (state.searchKinds.size === 0) {
    latest('search');
    state.searchBusy = false;
    state.searchHits = [];
    state.searchNotes = ['Turn on at least one of Films, Shows or Artists.'];
    renderSearch();
    return;
  }
  // A second search sent before the first answers must not be overwritten by it.
  const current = latest('search');
  state.searchBusy = true;
  renderSearch();
  try {
    const kinds = [...state.searchKinds].join(',');
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&kinds=${kinds}`);
    if (!current()) return;
    state.searchHits = r.hits;
    state.searchNotes = r.notes;
  } catch (err) {
    if (!current()) return;
    state.searchHits = [];
    state.searchNotes = [err.message];
  }
  state.searchBusy = false;
  renderSearch();
}

export function renderSearch() {
  const list = $('#search-results');
  $('#search-summary').textContent = state.searchBusy
    ? 'Searching…'
    : state.searchHits.length
      ? plural(state.searchHits.length, 'result')
      : '';

  releaseArtwork(list);
  list.replaceChildren();
  for (const note of state.searchNotes) list.append(el('div', { class: 'banner' }, note));
  if (state.searchBusy) return;

  if (state.searchHits.length === 0 && state.searchNotes.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, 'Nothing searched yet'),
        'Look up a film, show or artist, then add it without leaving the app.',
      ),
    );
    return;
  }
  for (const hit of state.searchHits) list.append(searchCard(hit));
}

/**
 * Synopsis and cast, fetched only when asked for and folded back into the card,
 * exactly as the trailer player is. Opening one closes any other.
 */
async function toggleDetails(hit, card) {
  const existing = card.querySelector('.details');
  if (existing) {
    existing.remove();
    return;
  }
  $$('.details').forEach((d) => d.remove());

  const holder = el('div', { class: 'details' }, el('div', { class: 'muted small' }, 'Looking it up…'));
  card.append(holder);

  try {
    const params = new URLSearchParams({ kind: hit.kind, id: hit.id });
    const d = await api(`/api/search/details?${params}`);
    holder.replaceChildren(...detailBody(d));
  } catch (err) {
    holder.replaceChildren(el('div', { class: 'muted small' }, err.message));
  }
}

/** The facts worth reading, in the order you would want to read them. */
function detailBody(d) {
  const facts = [
    d.runtime_minutes ? `${d.runtime_minutes} min` : null,
    d.content_rating || null,
    d.rating ? `${d.rating.toFixed(1)} / 10` : null,
    d.genres.length ? d.genres.join(', ') : null,
    d.studio || null,
  ].filter(Boolean);

  return [
    d.tagline ? el('p', { class: 'detail-tagline' }, d.tagline) : null,
    el('p', { class: 'detail-summary' }, d.summary || 'No synopsis available.'),
    facts.length ? el('p', { class: 'muted small' }, facts.join(' · ')) : null,
    d.directors.length
      ? el(
          'p',
          { class: 'small' },
          el('span', { class: 'muted' }, d.directors.length > 1 ? 'Directors: ' : 'Director: '),
          d.directors.join(', '),
        )
      : null,
    d.cast.length
      ? el(
          'div',
          { class: 'detail-cast' },
          ...d.cast.map((c) =>
            el(
              'span',
              { class: 'detail-actor' },
              c.name,
              c.role ? el('span', { class: 'muted' }, ` as ${c.role}`) : null,
            ),
          ),
        )
      : null,
    d.note ? el('p', { class: 'muted small' }, d.note) : null,
  ].filter(Boolean);
}

function searchCard(hit) {
  const card = el('article', { class: 'card' });
  const thumb = hit.thumb
    ? artwork(`/thumb?t=${encodeURIComponent(hit.thumb)}`, hit.title)
    : el('div', { class: 'art art-fallback' }, (hit.title || '?').charAt(0).toUpperCase());

  const action = hit.tracked
    ? el(
        'span',
        { class: 'tag held' },
        hit.kind === 'artist' ? '✓ Watched' : '✓ On watchlist',
      )
    : addToWatchlistButton({
        label: hit.kind === 'artist' ? 'Watch artist' : 'Add to watchlist',
        payload: { kind: hit.kind, id: hit.id, title: hit.title },
        onAdded: () => {
          hit.tracked = true;
          renderSearch();
        },
      });

  card.append(
    thumb,
    el(
      'div',
      {},
      el('p', { class: 'card-title' }, hit.title),
      el('p', { class: 'card-artist' }, hit.subtitle),
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: 'tag' }, KIND_TAG[hit.kind] ?? hit.kind),
        hit.year ? el('span', {}, String(hit.year)) : null,
        hit.in_library ? el('span', { class: 'tag held' }, '✓ In Plex') : null,
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: () =>
            togglePlayer(
              {
                kind: hit.kind === 'artist' ? 'single' : hit.kind,
                title: hit.title,
                subtitle: hit.kind === 'artist' ? hit.title : '',
                year: hit.year,
              },
              card,
            ),
        },
        hit.kind === 'artist' ? 'Play' : 'Trailer',
      ),
      hit.kind === 'artist'
        ? null
        : el(
            'button',
            { class: 'btn btn-tiny', onclick: () => toggleDetails(hit, card) },
            'Details',
          ),
      action,
    ),
  );
  return card;
}

$('#search-go').addEventListener('click', runSearch);
$('#search-box').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

wireChips('#search-chips', 'sk', () => state.searchKinds);
