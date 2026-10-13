/**
 * Following, Artists.
 */

import { cmp, fold, plural, relativeDays } from '../feed.js';
import { $, banner, el, safeHref } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import { artwork, releaseArtwork } from '../components.js';
import { refreshState } from './status.js';

/* --------------------------------------------------------------- artists */

const NEEDS_ATTENTION = new Set(['ambiguous', 'not_found', 'error']);
const ARTIST_SORTS = {
  name: (a, b) => cmp(a.sort_name, b.sort_name),
  albums: (a, b) => b.album_count - a.album_count || cmp(a.sort_name, b.sort_name),
  checked: (a, b) => cmp(a.last_checked_at ?? '', b.last_checked_at ?? ''),
};

export async function loadArtists() {
  try {
    const { artists } = await api('/api/artists');
    state.artists = artists;
    renderArtists();
  } catch (err) {
    banner(err.message);
  }
}

/**
 * Status and mute are separate questions. Filtering by status must not hide a
 * muted artist, or the one filter meant to surface problems hides the problems.
 */
function matchesStatus(a, status) {
  if (status === 'all') return true;
  if (status === 'muted') return a.muted === 1;
  if (status === 'attention') return NEEDS_ATTENTION.has(a.mb_status);
  return a.mb_status === 'resolved' || a.mb_status === 'manual';
}

function renderArtists() {
  const f = state.artistFilters;
  const q = fold(f.q).trim();
  const rows = state.artists
    .filter((a) => !q || fold(a.name).includes(q))
    .filter((a) => matchesStatus(a, f.status))
    .sort((a, b) => {
      if (f.sort === 'name' && f.status === 'all') {
        const pa = NEEDS_ATTENTION.has(a.mb_status) ? 0 : 1;
        const pb = NEEDS_ATTENTION.has(b.mb_status) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
      return ARTIST_SORTS[f.sort](a, b);
    });

  const active = f.q !== '' || f.status !== 'all' || f.sort !== 'name';
  $('#artist-summary').textContent =
    state.artists.length === 0
      ? ''
      : active
        ? `Showing ${rows.length} of ${plural(state.artists.length, 'artist')}`
        : plural(state.artists.length, 'artist');
  $('#artist-clear').hidden = !active;

  const list = $('#artist-list');
  releaseArtwork(list);
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, state.artists.length === 0 ? 'No artists yet' : 'No artists match'),
        state.artists.length === 0 ? 'Run a scan to read your Plex library.' : '',
      ),
    );
    return;
  }
  for (const a of rows) list.append(artistRow(a));
}

const STATUS_LABEL = {
  resolved: 'matched',
  manual: 'set by hand',
  pending: 'not checked',
  ambiguous: 'needs a choice',
  not_found: 'no match',
  error: 'lookup failed',
};

function artistRow(a) {
  const expanded = state.expanded === a.plex_key;
  const sub = [
    `${plural(a.album_count, 'album')} in Plex`,
    a.last_checked_at ? `checked ${relativeDays(a.last_checked_at.slice(0, 10))}` : 'never checked',
    a.muted ? 'muted' : null,
    a.last_error || null,
  ]
    .filter(Boolean)
    .join(' · ');

  const row = el(
    'div',
    { class: `artist-row${a.muted ? ' is-muted' : ''}` },
    artwork(`/thumb?key=${encodeURIComponent(a.plex_key)}`, a.name),
    el(
      'div',
      {},
      el('div', { class: 'artist-name' }, a.name),
      el('div', { class: 'artist-sub' }, sub),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el('span', { class: `status status-${a.mb_status}` }, STATUS_LABEL[a.mb_status] || a.mb_status),
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: () => {
            state.expanded = expanded ? null : a.plex_key;
            renderArtists();
          },
        },
        expanded ? 'Close' : 'Fix',
      ),
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await post('/api/artists/mute', { plex_key: a.plex_key, muted: !a.muted });
              loadArtists();
              refreshState();
            } catch (err) {
              banner(err.message);
              btn.disabled = false;
            }
          },
        },
        a.muted ? 'Unmute' : 'Mute',
      ),
    ),
  );
  if (expanded) row.append(fixPanel(a));
  return row;
}

function fixPanel(a) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'MusicBrainz artist ID',
    'aria-label': `MusicBrainz artist ID for ${a.name}`,
    value: a.mbid || '',
    spellcheck: 'false',
  });
  const save = async (mbid) => {
    try {
      await post('/api/artists/mbid', { plex_key: a.plex_key, mbid });
      state.expanded = null;
      banner(`${a.name} updated. It will be checked on the next scan.`, 'ok');
      loadArtists();
    } catch (err) {
      banner(err.message);
    }
  };
  const candidates = (a.mb_candidates || []).map((c) =>
    el(
      'div',
      { class: 'candidate' },
      el(
        'span',
        {},
        el('strong', {}, c.name),
        c.disambiguation ? ` — ${c.disambiguation}` : '',
        c.area ? el('span', { class: 'muted' }, ` (${c.area})`) : '',
      ),
      el(
        'span',
        { class: 'card-actions' },
        el(
          'a',
          {
            class: 'link',
            href: safeHref(`https://musicbrainz.org/artist/${encodeURIComponent(c.id)}`),
            target: '_blank',
            rel: 'noreferrer',
          },
          'view',
        ),
        el('button', { class: 'btn btn-tiny', onclick: () => save(c.id) }, 'Use this one'),
      ),
    ),
  );
  return el(
    'div',
    { class: 'fix' },
    candidates.length
      ? el('div', { class: 'small muted' }, 'More than one artist has this name. Which is yours?')
      : null,
    ...candidates,
    el(
      'div',
      { class: 'row' },
      input,
      el('button', { class: 'btn btn-tiny', onclick: () => save(input.value.trim()) }, 'Save'),
      a.mbid ? el('button', { class: 'btn btn-tiny', onclick: () => save('') }, 'Clear') : null,
    ),
    el(
      'div',
      { class: 'small muted' },
      'Find the ID in the address bar of the artist page on musicbrainz.org.',
    ),
  );
}

$('#artist-filter').addEventListener('input', (e) => {
  state.artistFilters.q = e.target.value;
  renderArtists();
});

$('#artist-status').addEventListener('change', (e) => {
  state.artistFilters.status = e.target.value;
  renderArtists();
});

$('#artist-sort').addEventListener('change', (e) => {
  state.artistFilters.sort = e.target.value;
  renderArtists();
});

$('#artist-clear').addEventListener('click', () => {
  state.artistFilters = { q: '', status: 'all', sort: 'name' };
  $('#artist-filter').value = '';
  $('#artist-status').value = 'all';
  $('#artist-sort').value = 'name';
  renderArtists();
});
