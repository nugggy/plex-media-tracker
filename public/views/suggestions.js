/**
 * Discover, Suggestions.
 */

import { fold, plural, filterSuggestionYears, dropFollowed } from '../feed.js';
import { $, banner, el, safeHref } from '../lib/dom.js';
import { api, poller, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import {
  addToWatchlistButton,
  artwork,
  confirmingButton,
  releaseArtwork,
  togglePlayer,
  wireChips,
} from '../components.js';

/* ----------------------------------------------------------- suggestions */

export async function loadSuggestions() {
  try {
    const { suggestions } = await api('/api/suggestions');
    state.suggestions = suggestions;
    renderSuggestions();
  } catch (err) {
    banner(err.message);
  }
}

function renderSuggestions() {
  const f = state.sgFilters;
  const q = fold(f.q).trim();
  const rows = filterSuggestionYears(
    dropFollowed(state.suggestions)
      .filter((s) => f.kinds.has(s.kind))
      .filter((s) => !q || fold(s.title).includes(q)),
    f.previousYears,
  );

  // Counted against what is actually offerable, since suggestions you already
  // follow are gone from the list and can never be reached by any filter.
  const offerable = dropFollowed(state.suggestions).length;
  $('#sg-summary').textContent = offerable
    ? `${rows.length} of ${plural(offerable, 'suggestion')}`
    : '';

  const list = $('#sg-list');
  releaseArtwork(list);
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el(
          'strong',
          {},
          state.suggestions.length ? 'Nothing matches' : 'No suggestions yet',
        ),
        state.suggestions.length
          ? f.previousYears
            ? 'Try a different search.'
            : 'Nothing here is from this year onwards. Tick Include previous years to see the rest, or build again to pull in newer titles.'
          : 'Press Build suggestions. It takes a couple of minutes, mostly waiting on ListenBrainz.',
      ),
    );
    return;
  }
  for (const s of rows.slice(0, 200)) list.append(suggestionCard(s));
}

const SG_TAG = { artist: 'artist', movie: 'film', show: 'show' };

function suggestionCard(s) {
  const card = el('article', { class: 'card' });
  // A poster comes from TMDB and an artist photograph from Wikimedia, both
  // through the same proxy the rest of the app uses, so the page never talks
  // to either host directly.
  const art = s.thumb
    ? artwork(`/thumb?url=${encodeURIComponent(s.thumb)}`, s.title)
    : el('div', { class: 'art art-fallback' }, (s.title || '?').charAt(0).toUpperCase());

  card.append(
    art,
    el(
      'div',
      {},
      el(
        'p',
        { class: 'card-title' },
        s.title,
        s.year ? el('span', { class: 'muted' }, ` (${s.year})`) : null,
      ),
      el('p', { class: 'card-artist' }, s.subtitle || ''),
      // Clamped to two lines in the stylesheet so the list still scans. The
      // whole synopsis is on the tooltip for anyone who wants it.
      s.overview ? el('p', { class: 'card-blurb', title: s.overview }, s.overview) : null,
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: 'tag' }, SG_TAG[s.kind] ?? s.kind),
        el('span', {}, `because you have ${s.seeds.slice(0, 3).join(', ')}`),
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
                kind: s.kind === 'artist' ? 'single' : s.kind,
                title: s.title,
                subtitle: s.kind === 'artist' ? s.title : '',
                year: s.year,
              },
              card,
            ),
        },
        s.kind === 'artist' ? 'Play' : 'Trailer',
      ),
      safeHref(s.link)
        ? el('a', { class: 'link', href: safeHref(s.link), target: '_blank', rel: 'noreferrer' }, 'Details')
        : null,
      suggestionAction(s),
      confirmingButton(
        'Not for me',
        'Hide, sure?',
        async () => {
          await post('/api/suggestions/hide', { kind: s.kind, id: s.id, hidden: true });
          loadSuggestions();
        },
        'Hiding…',
      ),
    ),
  );
  return card;
}

/**
 * A film or show goes onto the real Plex watchlist; an artist is simply
 * watched here, since Plex has no music watchlist.
 */
function suggestionAction(s) {
  if (s.tracked) {
    return el(
      'span',
      { class: 'tag held' },
      s.kind === 'artist' ? '✓ Watched' : '✓ On watchlist',
    );
  }
  // A film or show with no key cannot be added, so no button is offered.
  if (s.kind !== 'artist' && !s.rating_key) return null;

  return addToWatchlistButton({
    label: s.kind === 'artist' ? 'Watch artist' : 'Add to watchlist',
    payload: {
      kind: s.kind,
      id: s.kind === 'artist' ? s.id : s.rating_key,
      title: s.title,
    },
    onAdded: () => {
      s.tracked = true;
      renderSuggestions();
    },
  });
}

$('#sg-filter').addEventListener('input', (e) => {
  state.sgFilters.q = e.target.value;
  renderSuggestions();
});

$('#sg-previous').addEventListener('change', (e) => {
  state.sgFilters.previousYears = e.target.checked;
  renderSuggestions();
});

wireChips('#sg-chips', 'sg', () => state.sgFilters.kinds, renderSuggestions);

$('#suggest-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  banner('');
  try {
    await post('/api/suggestions/build', { what: 'all' });
    suggestionsPoll.start();
  } catch (err) {
    banner(err.message);
    btn.disabled = false;
  }
});

async function pollSuggestions() {
  try {
    const { running, message } = await api('/api/suggestions/progress');
    $('#suggest-btn').disabled = running;
    $('#suggest-btn').textContent = running ? 'Building…' : 'Build suggestions';
    if (message) banner(message, running ? 'info' : 'ok');
    if (!running) loadSuggestions();
    return running;
  } catch {
    $('#suggest-btn').disabled = false;
    $('#suggest-btn').textContent = 'Build suggestions';
    return false;
  }
}

export const suggestionsPoll = poller(pollSuggestions, 2000);
