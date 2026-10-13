/**
 * Library, Lyrics.
 */

import { plural, lyricCounts, visibleLyricTracks } from '../feed.js';
import { $, $$, banner, el } from '../lib/dom.js';
import { api, latest, poller, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import { ARM_MS } from '../components.js';

/* ---------------------------------------------------------------- lyrics */

export async function loadLyrics() {
  const ly = state.lyrics;
  loadLyricSummary();
  // Nothing picked yet: draw the empty state with its hint, not a blank page.
  if (!ly.artist && !ly.loading) renderLyrics();
  if (ly.artistsLoaded) return;
  try {
    const { artists } = await api('/api/artists');
    const select = $('#ly-artist');
    select.replaceChildren(
      el('option', { value: '' }, 'Choose an artist'),
      el('option', { value: LYRICS_WHOLE_LIBRARY }, 'Whole library'),
      ...artists.map((a) => el('option', { value: a.plex_key }, a.name)),
    );
    ly.artistsLoaded = true;
  } catch (err) {
    banner(err.message);
  }
}

/** The artist picker's value for every track in the music library. */
const LYRICS_WHOLE_LIBRARY = '*';

const count = (n) => Number(n).toLocaleString('en-AU');

/**
 * The line across the top of the tab, so it opens on how the whole library
 * stands rather than an empty page. The server counts the library's tracks in
 * the background, so the total can be missing at first; the line is drawn
 * without it, and asked for once more a few seconds later.
 */
let summaryRetry = null;
async function loadLyricSummary(retry = true) {
  const line = $('#ly-overview');
  const current = latest('lyric-summary');
  clearTimeout(summaryRetry);
  try {
    const r = await api('/api/lyrics/summary');
    if (!current()) return;
    const parts = [
      typeof r.tracks === 'number' ? `${count(r.tracks)} ${r.tracks === 1 ? 'track' : 'tracks'}` : null,
      typeof r.with_lyrics === 'number' ? `${count(r.with_lyrics)} with lyrics` : null,
      typeof r.saved_to_plex === 'number' ? `${count(r.saved_to_plex)} saved to Plex` : null,
    ].filter(Boolean);
    line.textContent = parts.join(' · ');
    line.hidden = parts.length === 0;
    if (r.tracks == null && retry) {
      summaryRetry = setTimeout(() => {
        if (state.tab === 'lyrics') loadLyricSummary(false);
      }, 5000);
    }
  } catch {
    // A server without the summary simply has no line.
    if (current()) line.hidden = true;
  }
}

async function loadLyricTracks() {
  const ly = state.lyrics;
  const wholeLibrary = ly.artist === LYRICS_WHOLE_LIBRARY;
  // Whole library can take seconds. Without this, picking one artist while it
  // loads would have the whole library land last, and Find lyrics would then
  // act on every track rather than the artist on screen.
  const current = latest('lyric-tracks');
  ly.limit = LYRIC_PAGE;
  if (!ly.artist) {
    ly.loading = false;
    ly.failed = false;
    ly.tracks = [];
    renderLyrics();
    return;
  }
  // Find lyrics and Save to Plex act on the tracks in hand, so neither can be
  // pressed until the list on screen matches the choice above it.
  ly.loading = true;
  $('#ly-fetch').disabled = true;
  $('#ly-save').disabled = true;
  $('#ly-summary').textContent = wholeLibrary
    ? 'Reading every track from Plex, this takes a few seconds…'
    : 'Reading tracks from Plex…';
  try {
    const params = wholeLibrary ? { library: '1' } : ly.album ? { album: ly.album } : { artist: ly.artist };
    const r = await api(`/api/lyrics/tracks?${new URLSearchParams(params)}`);
    if (!current()) return;
    ly.loading = false;
    ly.failed = false;
    ly.tracks = r.tracks;
    if (!ly.album) {
      const albumSelect = $('#ly-album');
      albumSelect.replaceChildren(
        el('option', { value: '' }, 'All albums'),
        ...r.albums.map((a) => el('option', { value: a.plex_key }, a.year ? `${a.title} (${a.year})` : a.title)),
      );
      albumSelect.disabled = r.albums.length === 0;
    }
    renderLyrics();
  } catch (err) {
    if (!current()) return;
    ly.loading = false;
    // The old tracks no longer match the choice, so nothing is left to act on.
    ly.failed = true;
    ly.tracks = [];
    renderLyrics();
    banner(err.message);
    $('#ly-summary').textContent = '';
  }
}

/** How many lyric cards are drawn at a time; Show more adds the next lot. */
const LYRIC_PAGE = 300;

const LYRIC_STATE_LABEL = {
  covered: 'In Plex',
  stored: 'Stored here',
  instrumental: 'Instrumental',
  missing: 'Missing',
};

function renderLyrics() {
  const ly = state.lyrics;
  const counts = lyricCounts(ly.tracks);
  const missing = ly.tracks.filter((t) => t.state === 'missing');
  const busy = ly.loading || ly.jobRunning;
  $('#ly-fetch').disabled = busy || missing.length === 0;
  const saveBtn = $('#ly-save');
  saveBtn.hidden = ON_PHONE;
  if (!saveBtn.classList.contains('is-armed')) saveBtn.disabled = busy || storedToSave().length === 0;
  $('#ly-summary').textContent = ly.tracks.length
    ? `${plural(counts.total, 'track')}: ${counts.covered} with lyrics in Plex, ${counts.stored} stored here, ` +
      `${counts.instrumental} instrumental, ${counts.missing} missing`
    : '';

  const list = $('#ly-list');
  list.replaceChildren();
  if (ly.tracks.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, ly.failed ? 'Could not read the tracks' : ly.artist ? 'No tracks' : 'Nothing picked yet'),
        ly.failed
          ? 'Choose again to retry.'
          : ly.artist
            ? 'Plex lists nothing under this choice.'
            : 'Pick an artist or the whole library to see tracks.',
        !ly.failed && !ly.artist
          ? el(
              'div',
              { class: 'empty-actions' },
              el('button', { type: 'button', class: 'btn btn-tiny', onclick: chooseWholeLibrary }, 'Whole library'),
            )
          : null,
      ),
    );
    return;
  }
  const visible = visibleLyricTracks(ly.tracks, ly.missingOnly);
  if (visible.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, 'Nothing missing'),
        'Every track here has lyrics in Plex, is stored here, or is instrumental.',
      ),
    );
    return;
  }
  const showArtist = ly.artist === LYRICS_WHOLE_LIBRARY;
  // A whole library runs to tens of thousands of tracks, and drawing them all
  // at once locks the page up, so the list comes a page at a time.
  for (const t of visible.slice(0, ly.limit)) list.append(lyricCard(t, showArtist));
  if (visible.length > ly.limit) {
    list.append(
      el(
        'div',
        { class: 'filter-summary' },
        el('span', {}, `Showing ${ly.limit} of ${plural(visible.length, 'track')}.`),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-tiny',
            onclick: () => {
              const first = ly.limit;
              ly.limit += LYRIC_PAGE;
              renderLyrics();
              // Keep the keyboard where the new cards start, not back at the top.
              list.children[first]?.querySelector('button')?.focus();
            },
          },
          'Show more',
        ),
      ),
    );
  }
}

function lyricCard(t, showArtist = false) {
  const card = el('article', { class: 'card' });
  const under = showArtist ? [t.artist, t.album].filter(Boolean).join(' · ') : t.album || '';
  const tagClass = t.state === 'covered' ? 'tag held' : t.state === 'stored' ? 'tag part-held' : 'tag';
  const minutes = t.duration_ms ? `${Math.floor(t.duration_ms / 60000)}:${String(Math.round((t.duration_ms % 60000) / 1000)).padStart(2, '0')}` : null;
  card.append(
    el('div', { class: 'art art-fallback' }, (t.title || '?').charAt(0).toUpperCase()),
    el(
      'div',
      {},
      el('p', { class: 'card-title' }, t.title),
      el('p', { class: 'card-artist' }, under),
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: tagClass }, (t.state === 'covered' || t.state === 'stored' ? '✓ ' : '') + LYRIC_STATE_LABEL[t.state]),
        minutes ? el('span', {}, minutes) : null,
        t.source === 'manual' ? el('span', { class: 'muted small' }, 'pasted by hand') : null,
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      t.state === 'stored'
        ? el('button', { class: 'btn btn-tiny', onclick: () => toggleLyric(t, card) }, 'Read')
        : null,
      t.state === 'covered'
        ? null
        : el('button', { class: 'btn btn-tiny', onclick: () => togglePaste(t, card) }, 'Paste lyrics'),
    ),
  );
  return card;
}

/** Timed lines read as plain text: the stamps are for players, not people. */
function stripTimestamps(lrc) {
  return lrc
    .split('\n')
    .map((line) => line.replace(/^(\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])+\s?/, ''))
    .join('\n')
    .trim();
}

async function toggleLyric(t, card) {
  const existing = card.querySelector('.player');
  if (existing) {
    existing.remove();
    return;
  }
  $$('.player').forEach((p) => p.remove());
  const holder = el('div', { class: 'player' }, el('div', { class: 'muted small' }, 'Loading…'));
  card.append(holder);
  try {
    const { lyric } = await api(`/api/lyrics/one?${new URLSearchParams({ rating_key: t.rating_key })}`);
    const text = lyric?.plain || (lyric?.synced ? stripTimestamps(lyric.synced) : '');
    holder.replaceChildren(
      el(
        'div',
        { class: 'player-bar' },
        el('span', { class: 'player-title muted small' }, lyric?.synced ? 'Timed lyrics, shown as text' : 'Lyrics'),
        el('button', { class: 'btn btn-tiny', onclick: () => holder.remove() }, 'Close'),
      ),
      el('pre', { class: 'lyric-text' }, text || 'Nothing stored.'),
    );
  } catch (err) {
    holder.replaceChildren(el('div', { class: 'muted small' }, err.message));
  }
}

function togglePaste(t, card) {
  const existing = card.querySelector('.player');
  if (existing) {
    existing.remove();
    return;
  }
  $$('.player').forEach((p) => p.remove());
  const input = el('textarea', {
    class: 'input lyric-input',
    placeholder: 'Paste the lyrics, or an LRC file with timed lines',
    'aria-label': `Lyrics for ${t.title}`,
  });
  const save = el(
    'button',
    {
      class: 'btn btn-tiny btn-primary',
      onclick: async () => {
        save.disabled = true;
        try {
          await post('/api/lyrics/manual', { track: t, text: input.value });
          banner(`Lyrics saved for ${t.title}.`, 'ok');
          loadLyricTracks();
        } catch (err) {
          banner(err.message);
          save.disabled = false;
        }
      },
    },
    'Save',
  );
  card.append(
    el(
      'div',
      { class: 'player' },
      input,
      el(
        'div',
        { class: 'card-actions' },
        save,
        el('button', { class: 'btn btn-tiny', onclick: (e) => e.currentTarget.closest('.player').remove() }, 'Cancel'),
      ),
    ),
  );
  input.focus();
}

/** The Whole library shortcut: the same as picking it from the artist list. */
function chooseWholeLibrary() {
  const select = $('#ly-artist');
  select.value = LYRICS_WHOLE_LIBRARY;
  select.dispatchEvent(new Event('change'));
  select.focus();
}

$('#ly-whole').addEventListener('click', chooseWholeLibrary);

$('#ly-artist').addEventListener('change', (e) => {
  state.lyrics.artist = e.target.value;
  state.lyrics.album = '';
  const albumSelect = $('#ly-album');
  albumSelect.value = '';
  // The whole library has no single artist to list albums for.
  if (state.lyrics.artist === LYRICS_WHOLE_LIBRARY) {
    albumSelect.replaceChildren(el('option', { value: '' }, 'All albums'));
    albumSelect.disabled = true;
  }
  loadLyricTracks();
});

$('#ly-missing-only').addEventListener('change', (e) => {
  state.lyrics.missingOnly = e.target.checked;
  state.lyrics.limit = LYRIC_PAGE;
  renderLyrics();
});

$('#ly-album').addEventListener('change', (e) => {
  state.lyrics.album = e.target.value;
  loadLyricTracks();
});

$('#ly-fetch').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (state.lyrics.loading) return;
  btn.disabled = true;
  try {
    await post('/api/lyrics/fetch', { tracks: state.lyrics.tracks.filter((t) => t.state === 'missing') });
    lyricsPoll.start();
  } catch (err) {
    banner(err.message);
    btn.disabled = false;
  }
});

/** The phone cannot reach the NAS's folders, so it has no Save to Plex. */
const ON_PHONE = Boolean(window.Capacitor?.isNativePlatform?.());

function storedToSave() {
  return state.lyrics.tracks.filter((t) => t.state === 'stored');
}

// Two presses, as with Dismiss: the first says how many files, the second writes them.
let lySaveTimer = null;
$('#ly-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const keys = storedToSave().map((t) => t.rating_key);
  if (keys.length === 0) return;
  if (lySaveTimer === null) {
    btn.classList.add('is-armed');
    btn.textContent = `Save ${plural(keys.length, 'lyric file')} to Plex?`;
    lySaveTimer = setTimeout(() => {
      lySaveTimer = null;
      btn.classList.remove('is-armed');
      btn.textContent = 'Save to Plex';
    }, ARM_MS);
    return;
  }
  clearTimeout(lySaveTimer);
  lySaveTimer = null;
  btn.classList.remove('is-armed');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  banner('');
  try {
    await post('/api/lyrics/export', { keys });
    lyricsPoll.start();
  } catch (err) {
    banner(err.message);
    btn.textContent = 'Save to Plex';
    btn.disabled = false;
  }
});

async function pollLyrics() {
  try {
    const { running, message, ok } = await api('/api/lyrics/progress');
    state.lyrics.jobRunning = running;
    $('#ly-fetch').textContent = running ? 'Working…' : 'Find lyrics';
    if (running) $('#ly-fetch').disabled = true;
    if (!running) $('#ly-save').textContent = 'Save to Plex';
    if (message) banner(message, running ? 'info' : ok ? 'ok' : undefined);
    if (!running) {
      loadLyricTracks();
      loadLyricSummary();
    }
    return running;
  } catch {
    state.lyrics.jobRunning = false;
    $('#ly-fetch').textContent = 'Find lyrics';
    $('#ly-fetch').disabled = false;
    return false;
  }
}

export const lyricsPoll = poller(pollLyrics, 1000);
