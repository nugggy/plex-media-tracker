/**
 * The Dashboard: now playing, libraries, recently added and watch history.
 */

import { plural } from '../feed.js';
import { $, banner, el, safeHref } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import { artwork, plexHref, releaseArtwork, tile } from '../components.js';

/* -------------------------------------------------------------- dashboard */

export function loadDash() {
  refreshNowPlaying();
  loadDashLibrary();
  loadHistory();
}

export function stopNowPlaying() {
  clearTimeout(state.dash.timer);
  state.dash.timer = null;
}

function dashError(node, err) {
  node.replaceChildren(el('div', { class: 'empty' }, el('strong', {}, 'Could not reach Plex'), err.message));
}

function clock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const mbps = (kbps) => `${(kbps / 1000).toFixed(1)} Mbps`;
const count = (n) => n.toLocaleString('en-AU');

async function refreshNowPlaying() {
  stopNowPlaying();
  // One request at a time. A Stop press or the window coming back into view
  // while one is out asks for another round once it lands, rather than
  // starting a second loop alongside the first.
  if (state.dash.loading) {
    state.dash.again = true;
    return;
  }
  state.dash.loading = true;
  const list = $('#np-list');
  try {
    const { streams, bandwidth_kbps } = await api('/api/dash/sessions');
    const pill = $('#count-streams');
    pill.textContent = streams.length;
    pill.hidden = streams.length === 0;

    const transcodes = streams.filter((s) => s.decision === 'Transcode').length;
    $('#np-summary').textContent = streams.length
      ? [
          plural(streams.length, 'stream'),
          transcodes ? `${transcodes} transcoding` : 'none transcoding',
          mbps(bandwidth_kbps),
        ].join(' · ')
      : 'Nothing is playing.';

    releaseArtwork(list);
    list.replaceChildren(
      ...(streams.length
        ? streams.map(streamRow)
        : [el('div', { class: 'empty' }, el('strong', {}, 'All quiet'), 'Nobody is watching or listening right now.')]),
    );
  } catch (err) {
    $('#np-summary').textContent = '';
    dashError(list, err);
  } finally {
    state.dash.loading = false;
  }
  if (state.dash.again) {
    state.dash.again = false;
    refreshNowPlaying();
    return;
  }
  stopNowPlaying();
  if (state.tab === 'dash' && !document.hidden) state.dash.timer = setTimeout(refreshNowPlaying, 10_000);
}

// No point asking Plex every ten seconds while the window is out of sight.
document.addEventListener('visibilitychange', () => {
  if (state.tab !== 'dash') return;
  if (document.hidden) stopNowPlaying();
  else refreshNowPlaying();
});

const DECISION_TAG = { Transcode: 'tag event', 'Direct stream': 'tag part-held', 'Direct play': 'tag held' };
const PLAYER_STATE = { paused: 'Paused', buffering: 'Buffering' };

function streamRow(s) {
  // The armed state lives in `dash`, not the button, so the ten second
  // redraw cannot swallow the confirming click.
  const armed = state.dash.stopArmed === s.session_id;
  const stop = s.session_id
    ? el(
        'button',
        { type: 'button', class: armed ? 'btn btn-tiny is-armed' : 'btn btn-tiny', onclick: () => stopClicked(s) },
        armed ? 'Confirm stop' : 'Stop',
      )
    : null;

  return el(
    'div',
    { class: 'artist-row stream-row' },
    artwork(s.thumb, s.title),
    el(
      'div',
      { class: 'stream-main' },
      el('div', { class: 'artist-name' }, s.title),
      el('div', { class: 'artist-sub' }, s.subtitle),
      el(
        'div',
        { class: 'artist-sub' },
        [
          s.user,
          s.player,
          s.platform,
          s.local ? 'Home network' : 'Remote',
          s.quality,
          s.bandwidth_kbps ? mbps(s.bandwidth_kbps) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      el(
        'div',
        { class: 'stream-progress' },
        el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${Math.round(s.progress * 100)}%` })),
        el('span', { class: 'muted small' }, `${clock(s.position_ms)} of ${clock(s.duration_ms)}`),
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      el('span', { class: 'tag' }, PLAYER_STATE[s.state] ?? 'Playing'),
      el('span', { class: DECISION_TAG[s.decision] ?? 'tag' }, s.decision),
      stop,
    ),
  );
}

/** Two clicks to stop someone's film, and the first one wears off after five seconds. */
async function stopClicked(s) {
  if (state.dash.stopArmed !== s.session_id) {
    state.dash.stopArmed = s.session_id;
    refreshNowPlaying();
    setTimeout(() => {
      if (state.dash.stopArmed !== s.session_id) return;
      state.dash.stopArmed = null;
      if (state.tab === 'dash') refreshNowPlaying();
    }, 5000);
    return;
  }
  state.dash.stopArmed = null;
  try {
    await post('/api/dash/stop', { session_id: s.session_id });
    banner(`Stopped ${s.title} for ${s.user}.`, 'ok');
  } catch (err) {
    banner(err.message);
  }
  refreshNowPlaying();
}

const LIB_LABEL = { movie: 'films', show: 'shows', artist: 'artists', photo: 'photos' };

async function loadDashLibrary() {
  const tiles = $('#dash-libs');
  const strip = $('#dash-added');
  try {
    const { libraries, added } = await api('/api/dash/library');
    tiles.replaceChildren(
      ...libraries.map((l) => {
        const [main, ...rest] = l.counts;
        return tile(
          l.title,
          main ? count(main.plays) : '·',
          [main?.label ?? LIB_LABEL[l.type] ?? l.type, ...rest.map((c) => `${count(c.plays)} ${c.label}`)].join(' · '),
        );
      }),
    );
    releaseArtwork(strip);
    strip.replaceChildren(
      ...(added.length
        ? added.map((a) => {
            const href = safeHref(plexHref(a.rating_key));
            return el(
              href ? 'a' : 'div',
              { class: 'added-item', href, target: href ? '_blank' : null, rel: href ? 'noreferrer' : null },
              artwork(a.thumb, a.title),
              el('div', { class: 'added-title' }, a.title),
              el('div', { class: 'artist-sub' }, [a.subtitle, addedWhen(a.added_at)].filter(Boolean).join(' · ')),
            );
          })
        : [el('div', { class: 'empty' }, el('strong', {}, 'Nothing new'), 'Nothing has been added lately.')]),
    );
  } catch (err) {
    tiles.replaceChildren();
    dashError(strip, err);
  }
}

function addedWhen(unix) {
  if (!unix) return '';
  const days = Math.floor((Date.now() / 1000 - unix) / 86_400);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

async function loadHistory() {
  const recent = $('#hist-recent');
  const lists = ['#hist-titles', '#hist-users', '#hist-platforms', '#hist-kinds'];
  try {
    const h = await api(`/api/dash/history?days=${$('#hist-days').value}`);
    $('#hist-tiles').replaceChildren(
      tile('Plays', count(h.plays), h.truncated ? 'the latest 5,000 only' : `in the last ${plural(h.days, 'day')}`),
      tile('Titles', count(h.titles), 'films, shows and artists'),
      tile('Users', count(h.users), 'who pressed play'),
    );
    [h.top_titles, h.top_users, h.top_platforms, h.by_kind].forEach((rows, i) => rankList(lists[i], rows));
    releaseArtwork(recent);
    recent.replaceChildren(
      ...(h.recent.length
        ? h.recent.map((p) =>
            el(
              'div',
              { class: 'artist-row poster-row' },
              artwork(p.thumb, p.title),
              el(
                'div',
                {},
                el('div', { class: 'artist-name' }, p.title),
                el('div', { class: 'artist-sub' }, [p.subtitle, p.user, p.platform].filter(Boolean).join(' · ')),
              ),
              el('div', { class: 'muted small' }, playedWhen(p.viewed_at)),
            ),
          )
        : [el('div', { class: 'empty' }, el('strong', {}, 'No plays'), 'Nothing was watched or listened to in this period.')]),
    );
  } catch (err) {
    $('#hist-tiles').replaceChildren();
    for (const id of lists) $(id).replaceChildren();
    dashError(recent, err);
  }
}

function playedWhen(unix) {
  return new Date(unix * 1000).toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** A ranked list, each bar scaled to the top entry, with the count in text beside it. */
function rankList(sel, rows) {
  const top = rows[0]?.plays || 1;
  $(sel).replaceChildren(
    ...(rows.length
      ? rows.map((r) =>
          el(
            'div',
            { class: 'rank-row', title: `${r.label}: ${plural(r.plays, 'play')}` },
            el('span', { class: 'rank-label' }, r.label),
            el('span', { class: 'rank-bar' }, el('span', { style: `width:${Math.max(2, (r.plays / top) * 100)}%` })),
            el('span', { class: 'rank-value' }, count(r.plays)),
          ),
        )
      : [el('p', { class: 'muted small' }, 'Nothing yet.')]),
  );
}

$('#hist-days').addEventListener('change', loadHistory);
