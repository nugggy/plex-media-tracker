/**
 * Discover, Trending.
 */

import { fold, plural, formatDate, relativeDays, filterCatalogue, daysSince } from '../feed.js';
import { $, banner, el } from '../lib/dom.js';
import { api, poller, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import {
  addToWatchlistButton,
  artwork,
  confirmingButton,
  gridPlayer,
  linkButton,
  releaseArtwork,
  wireChips,
} from '../components.js';

/* -------------------------------------------------------------- trending */

export async function loadTrending() {
  try {
    const r = await api('/api/trending');
    state.trending = r.items;
    state.trendingBuiltAt = r.built_at;
    state.trendingHasKey = r.has_tmdb_key;
    // A server that predates these fields still gets a notice: a chart over a
    // week old is stale by the same measure the server uses.
    state.trendingStale = r.stale ?? (chartAge() ?? 0) >= 7;
    state.trendingBuilding = Boolean(r.building);
    // The server can start a build by itself, on start-up or when this tab is
    // opened, so a build already under way is followed here too.
    if (state.trendingBuilding) trendingPoll.start();
    renderTrending();
  } catch (err) {
    banner(err.message);
  }
}

/** Days since the oldest chart was built, or null when none has been. */
function chartAge() {
  const ages = Object.values(state.trendingBuiltAt ?? {})
    .map((d) => daysSince(d))
    .filter((n) => n !== null);
  return ages.length ? Math.max(...ages) : null;
}

/**
 * The notice above the charts. The small "built 18 days ago" beside each
 * heading was too easy to miss, so an old chart, or one being rebuilt, says so
 * in a line of its own with the button to fix it.
 */
function renderTrendingNotice() {
  const notice = $('#tr-notice');
  if (state.trendingBuilding) {
    notice.replaceChildren(el('span', {}, 'Rebuilding the charts…'));
    notice.hidden = false;
    return;
  }
  if (!state.trendingStale || !state.trending.length) {
    notice.hidden = true;
    notice.replaceChildren();
    return;
  }
  const age = chartAge();
  notice.replaceChildren(
    el(
      'span',
      {},
      age ? `These charts are ${plural(age, 'day')} old.` : 'These charts are out of date.',
    ),
    el(
      'button',
      { type: 'button', class: 'btn btn-tiny', onclick: (e) => startTrendingBuild(e.currentTarget) },
      'Rebuild',
    ),
  );
  notice.hidden = false;
}

/**
 * The advice line under "Nothing matches" in Trending. Pulled out of the
 * render function because nesting a third condition into the inline ternary
 * is exactly how the catalogue-already-ticked case slipped through twice.
 */
function trendingMatchHint(f) {
  if (f.kinds.size === 0) return 'Turn at least one type back on.';
  if (f.held !== 'all') return 'Try a different search, or set the Plex filter back to In Plex or not.';
  if (f.catalogue) return 'Try a different search.';
  return 'Try a different search, or tick Catalogue to include older records.';
}

function renderTrending() {
  const f = state.trFilters;
  const q = fold(f.q).trim();
  const rows = filterCatalogue(
    state.trending
      .filter((t) => f.kinds.has(t.kind))
      .filter((t) => !q || fold(t.title).includes(q) || fold(t.subtitle).includes(q))
      // "Not in Plex" keeps rows that could not be checked as well, since
      // nothing says they are held and this filter is for finding what to get.
      .filter((t) => f.held === 'all' || (f.held === 'held') === t.in_library),
    f.catalogue,
  );

  $('#tr-summary').textContent = state.trending.length
    ? `${rows.length} of ${plural(state.trending.length, 'item')}`
    : '';

  renderTrendingNotice();
  const list = $('#tr-list');
  releaseArtwork(list);
  list.replaceChildren();

  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, state.trending.length ? 'Nothing matches' : 'Nothing built yet'),
        state.trending.length
          ? trendingMatchHint(f)
          : state.trendingHasKey
            ? 'Press Build trending. It takes a minute or so the first time.'
            : 'Press Build trending for country music. Films and shows need a free TMDB key in Settings.',
      ),
    );
    return;
  }

  // One run of posters per chart, under its own heading. Without this the
  // charts read as one flat list, so a row numbered 1 appears two or three
  // times with nothing saying which chart it belongs to. The fixed order
  // matches the filter chips, not the alphabetical kind order the rows arrive
  // in from the server.
  for (const kind of TR_KIND_ORDER) {
    const group = rows.filter((t) => t.kind === kind);
    if (group.length === 0) continue;
    list.append(trendingHeadingRow(kind, group.length));
    for (const t of group) list.append(trendingCard(t));
  }
}

const TR_KIND_ORDER = ['movie', 'show', 'album'];
const TR_KIND_LABEL = { movie: 'Films', show: 'Shows', album: 'Albums' };

/**
 * The heading above one chart's run of posters. Built per kind rather than
 * once for the whole tab: after a partial rebuild one chart can be a lot
 * older than the others, and labelling a stale chart with today's date is
 * the single worst outcome this feature can produce.
 */
function trendingHeadingRow(kind, count) {
  const built = state.trendingBuiltAt?.[kind];
  const relative = built ? `built ${relativeDays(built)}` : null;
  return el(
    'div',
    { class: 'day-head' },
    el('span', { class: 'day-name' }, TR_KIND_LABEL[kind] ?? kind),
    el(
      'span',
      { class: 'muted small' },
      [relative, plural(count, 'item')].filter(Boolean).join(' · '),
    ),
  );
}

/**
 * One chart entry as a poster: the rank over the corner, the title and who or
 * what it is under it, a status chip, and the actions in a row beneath. The
 * actions are ordinary buttons and links in reading order, so the keyboard
 * reaches each one without any hovering.
 */
function trendingCard(t) {
  const card = el('article', { class: 'poster-card' });
  const isVideo = t.kind === 'movie' || t.kind === 'show';
  // Artwork always goes through the /thumb proxy, the same as every other
  // card, so the page never contacts Apple or TMDB directly.
  const art = artwork(t.thumb ? `/thumb?url=${encodeURIComponent(t.thumb)}` : null, t.title, isVideo);

  card.append(
    el(
      'div',
      { class: `poster-art${isVideo ? '' : ' is-square'}` },
      art,
      // The rank is the chart position, not the row's position in this list,
      // so it keeps counting from the real chart even when catalogue rows are
      // filtered out and the visible numbers skip.
      el('span', { class: 'rank', 'aria-hidden': 'true' }, String(t.rank)),
    ),
    el(
      'div',
      { class: 'poster-body' },
      el(
        'p',
        { class: 'poster-title', title: t.title },
        el('span', { class: 'sr-only' }, `Number ${t.rank}: `),
        t.title,
      ),
      el(
        'p',
        { class: 'poster-meta' },
        [t.subtitle, t.release_date ? formatDate(t.release_date) : null].filter(Boolean).join(' · '),
      ),
      el('div', { class: 'card-meta' }, trendingHeldTag(t), trackedTag(t)),
      el(
        'div',
        { class: 'poster-actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-tiny',
            onclick: () =>
              gridPlayer(
                {
                  // 'single' here only tells the YouTube lookup to search for
                  // music rather than a trailer.
                  kind: t.kind === 'album' ? 'single' : t.kind,
                  title: t.title,
                  subtitle: t.subtitle,
                },
                card,
              ),
          },
          isVideo ? 'Trailer' : 'Play',
        ),
        linkButton(t.link, 'Details'),
        trendingAction(t),
        confirmingButton(
          'Not for me',
          'Hide, sure?',
          async () => {
            await post('/api/trending/hide', { kind: t.kind, id: t.id, hidden: true });
            loadTrending();
          },
          'Hiding…',
        ),
      ),
    ),
  );
  return card;
}

/**
 * "Not in Plex" only when the row could actually be checked: a film or show
 * needs a resolved Plex GUID, music a resolved artist. Without one, a missing
 * tick means "don't know", and labelling that as not held would be a guess.
 */
function trendingHeldTag(t) {
  if (t.in_library) return el('span', { class: 'tag held' }, '✓ In Plex');
  const checked = t.kind === 'movie' || t.kind === 'show' ? t.guid : t.mbid;
  return checked ? el('span', { class: 'tag not-held' }, 'Not in Plex') : null;
}

/** On watchlist, or Watched for music, once followed. */
function trackedTag(t) {
  if (!t.tracked) return null;
  const isVideo = t.kind === 'movie' || t.kind === 'show';
  return el('span', { class: 'tag held' }, isVideo ? '✓ On watchlist' : '✓ Watched');
}

/**
 * A film or show goes onto the real Plex watchlist. Music has no Plex
 * equivalent, so the action is to watch the artist, as Suggestions does.
 */
function trendingAction(t) {
  const isVideo = t.kind === 'movie' || t.kind === 'show';
  // Already followed: the chip says so, and there is nothing left to press.
  if (t.tracked) return null;
  // With no resolved Plex key or MusicBrainz id there is nothing to add, so
  // offer no button rather than one that would fail.
  if (isVideo && !t.rating_key) return null;
  if (!isVideo && !t.mbid) return null;

  return addToWatchlistButton({
    label: isVideo ? 'Add to watchlist' : 'Watch artist',
    payload: {
      kind: isVideo ? t.kind : 'artist',
      id: isVideo ? t.rating_key : t.mbid,
      title: isVideo ? t.title : t.subtitle,
    },
    onAdded: () => {
      // The chart repeats artists and films heavily (the same artist or
      // title can sit at several ranks), so marking only the clicked row
      // would leave every other occurrence still offering the button.
      for (const other of state.trending) {
        if (isVideo ? other.rating_key === t.rating_key : other.mbid === t.mbid) {
          other.tracked = true;
        }
      }
      renderTrending();
    },
  });
}

$('#tr-filter').addEventListener('input', (e) => {
  state.trFilters.q = e.target.value;
  renderTrending();
});

$('#tr-held').addEventListener('change', (e) => {
  state.trFilters.held = e.target.value;
  renderTrending();
});

$('#tr-catalogue').addEventListener('change', (e) => {
  state.trFilters.catalogue = e.target.checked;
  renderTrending();
});

wireChips('#tr-chips', 'tr', () => state.trFilters.kinds, renderTrending);

/**
 * Starts a rebuild, from the button at the top or the one in the notice. The
 * server may already be building by itself and answers with an error saying
 * so. That is not a failure, so the page simply follows the build under way.
 */
async function startTrendingBuild(btn) {
  btn.disabled = true;
  try {
    await post('/api/trending/build', {});
  } catch (err) {
    if (!/already/i.test(err.message)) {
      banner(err.message);
      btn.disabled = false;
      return;
    }
  }
  state.trendingBuilding = true;
  renderTrendingNotice();
  trendingPoll.start();
}

$('#trending-btn').addEventListener('click', (e) => startTrendingBuild(e.currentTarget));

async function pollTrending() {
  try {
    const { running, message } = await api('/api/trending/progress');
    $('#trending-btn').disabled = running;
    $('#trending-btn').textContent = running ? 'Building…' : 'Build trending';
    if (state.trendingBuilding !== running) {
      state.trendingBuilding = running;
      renderTrendingNotice();
    }
    // banner(), not #tr-summary: loadTrending() below re-renders the summary
    // line straight after this, which would overwrite it in milliseconds and
    // the finished message (in particular which chart failed and is showing
    // stale data) would never actually be read.
    if (message) banner(message, running ? 'info' : 'ok');
    if (!running) loadTrending();
    return running;
  } catch {
    $('#trending-btn').disabled = false;
    $('#trending-btn').textContent = 'Build trending';
    state.trendingBuilding = false;
    renderTrendingNotice();
    return false;
  }
}

export const trendingPoll = poller(pollTrending, 1500);
