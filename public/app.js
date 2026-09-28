import {
  ALL_TYPES,
  TYPE_LABELS,
  KIND_TAG,
  NOTABLE_EVENTS,
  HORIZONS,
  DEFAULT_HORIZONS,
  DEFAULT_HELD,
  SORTS,
  cmp,
  fold,
  plural,
  formatDate,
  relativeDays,
  formatWhen,
  relativeWhen,
  filtersActive,
  applyFilters,
  groupEpisodes,
  groupByDay,
  dayHeading,
  filterSuggestionYears,
  dropFollowed,
  filterCatalogue,
} from './feed.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  tab: 'out',
  artists: [],
  watchlist: [],
  removals: [],
  suggestions: [],
  expanded: null,
  pollTimer: null,
  wasRunning: false,
  cache: { out: [], upcoming: [], dismissed: [] },
  filters: {
    out: {
      q: '',
      types: new Set(ALL_TYPES),
      sort: 'date-desc',
      horizon: DEFAULT_HORIZONS.out,
      cinema: false,
      held: DEFAULT_HELD.out,
    },
    upcoming: {
      q: '',
      types: new Set(ALL_TYPES),
      sort: 'soonest',
      horizon: DEFAULT_HORIZONS.upcoming,
      cinema: false,
      held: DEFAULT_HELD.upcoming,
    },
  },
  artistFilters: { q: '', status: 'all', sort: 'name' },
  wlFilters: { q: '', types: new Set(['movie', 'show']), sort: 'title' },
  sgFilters: { q: '', kinds: new Set(['artist', 'movie', 'show']), previousYears: false },
  trending: [],
  trendingBuiltAt: null,
  trendingHasKey: true,
  // Singles are off by default: the brief for the chart build treats them as
  // noise until asked for, so the tab opens the same way.
  trFilters: { q: '', kinds: new Set(['movie', 'show', 'album']), catalogue: false, held: 'all' },
  searchKinds: new Set(['movie', 'show', 'artist']),
  searchHits: [],
  searchNotes: [],
  searchBusy: false,
  gaps: null,
  library: null,
  machineId: null,
  // The Dashboard's refresh timer, and which stream's Stop is waiting for a second press.
  dash: { timer: null, stopArmed: null },
};

/* ------------------------------------------------------------------ util */

async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function banner(message, kind) {
  const node = $('#banner');
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.className = kind === 'ok' ? 'banner ok' : 'banner';
  node.hidden = false;
}


/* ------------------------------------------------------------------ tabs */

function showTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => {
    p.hidden = p.id !== `panel-${name}`;
  });
  if (name === 'search') renderSearch();
  if (name === 'library') loadLibrary();
  if (name === 'dash') loadDash();
  else stopNowPlaying();
  if (name === 'out' || name === 'upcoming') loadReleases();
  if (name === 'watchlist') {
    loadWatchlist();
    loadGaps();
  }
  if (name === 'artists') loadArtists();
  if (name === 'suggestions') loadSuggestions();
  if (name === 'trending') loadTrending();
  if (name === 'settings') loadSettings();
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));

/* -------------------------------------------------------- youtube player */

/**
 * The embed is built only when asked for, so opening a tab never loads dozens
 * of iframes at once.
 */
async function togglePlayer(item, card) {
  const existing = card.querySelector('.player');
  if (existing) {
    existing.remove();
    return;
  }
  $$('.player').forEach((p) => p.remove());

  const holder = el(
    'div',
    { class: 'player' },
    el('div', { class: 'muted small' }, 'Finding it on YouTube…'),
  );
  card.append(holder);

  const params = new URLSearchParams({
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle ?? '',
  });
  if (item.year) params.set('year', String(item.year));

  try {
    const r = await api(`/api/youtube?${params}`);
    holder.replaceChildren();
    if (r.embed_url) {
      // The frame is collapsed by height, never unmounted, so folding it away
      // shrinks the card without stopping what is playing.
      const frame = el(
        'div',
        { class: 'player-frame' },
        el('iframe', {
          src: r.embed_url,
          title: `${item.title} on YouTube`,
          allow: 'accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen',
          allowfullscreen: true,
          loading: 'lazy',
          referrerpolicy: 'strict-origin-when-cross-origin',
        }),
      );

      const chevron = el('span', { class: 'chev' }, '▾');
      const collapseBtn = el(
        'button',
        {
          class: 'btn btn-tiny',
          title: 'Fold the video away and keep it playing',
          onclick: () => {
            const folded = holder.classList.toggle('is-collapsed');
            chevron.textContent = folded ? '▸' : '▾';
            collapseBtn.textContent = folded ? 'Show' : 'Hide';
            collapseBtn.prepend(chevron);
          },
        },
        'Hide',
      );
      collapseBtn.prepend(chevron);

      holder.append(
        el(
          'div',
          { class: 'player-bar' },
          el(
            'span',
            { class: 'player-title muted small' },
            // Naming the match makes a wrong one obvious instead of silent.
            r.video_title ? `Playing: ${r.video_title}` : 'Playing',
          ),
          el(
            'span',
            { class: 'card-actions' },
            el(
              'a',
              { class: 'link', href: r.search_url, target: '_blank', rel: 'noreferrer' },
              'Wrong one?',
            ),
            collapseBtn,
            el(
              'button',
              {
                class: 'btn btn-tiny',
                title: 'Stop and close the player',
                onclick: () => holder.remove(),
              },
              'Close',
            ),
          ),
        ),
        frame,
      );
    } else {
      holder.append(
        el('span', { class: 'muted small' }, 'No video found automatically. '),
        el(
          'a',
          { class: 'link', href: r.search_url, target: '_blank', rel: 'noreferrer' },
          'Search YouTube',
        ),
      );
    }
  } catch (err) {
    holder.replaceChildren(el('div', { class: 'muted small' }, err.message));
  }
}

/* --------------------------------------------------------- release filters */

const panelKey = () => (state.tab === 'upcoming' ? 'upcoming' : 'out');
const currentView = () =>
  state.tab === 'upcoming' ? 'upcoming' : $('#show-dismissed').checked ? 'dismissed' : 'out';

function buildFilterBar(key) {
  const f = state.filters[key];
  const bar = $(`#filters-${key}`);
  const sortOptions =
    key === 'upcoming'
      ? ['soonest', 'date-desc', 'name', 'title']
      : ['date-desc', 'date-asc', 'name', 'title'];

  const search = el('input', {
    type: 'search',
    class: 'input search',
    placeholder: 'Search titles, artists or films',
    autocomplete: 'off',
    value: f.q,
    oninput: (e) => {
      f.q = e.target.value;
      renderReleases();
    },
  });

  const chips = el(
    'div',
    { class: 'chips', role: 'group', 'aria-label': 'Types' },
    ALL_TYPES.map((type) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${f.types.has(type) ? ' is-on' : ''}`,
          'aria-pressed': f.types.has(type),
          onclick: () => {
            if (f.types.has(type)) f.types.delete(type);
            else f.types.add(type);
            buildFilterBar(key);
            renderReleases();
          },
        },
        TYPE_LABELS[type],
      ),
    ),
  );

  const sort = el(
    'select',
    {
      class: 'input',
      'aria-label': 'Sort',
      onchange: (e) => {
        f.sort = e.target.value;
        renderReleases();
      },
    },
    sortOptions.map((v) => el('option', { value: v, selected: f.sort === v }, SORTS[v].label)),
  );

  const controls = [search, chips, sort];

  controls.push(
    el(
      'label',
      { class: 'check', title: 'Hide anything already on your Plex server' },
      el('input', {
        type: 'checkbox',
        checked: !f.held,
        onchange: (e) => {
          f.held = !e.target.checked;
          renderReleases();
        },
      }),
      ' Hide what I have',
    ),
  );

  controls.push(
    el(
      'label',
      { class: 'check', title: 'Films with only a cinema date, not yet watchable at home' },
      el('input', {
        type: 'checkbox',
        checked: f.cinema,
        onchange: (e) => {
          f.cinema = e.target.checked;
          renderReleases();
        },
      }),
      ' Cinema',
    ),
  );

  controls.push(
    el(
      'select',
      {
        class: 'input',
        'aria-label': key === 'upcoming' ? 'How far ahead' : 'How far back',
        onchange: (e) => {
          f.horizon = Number(e.target.value);
          renderReleases();
        },
      },
      HORIZONS[key].map((h) =>
        el('option', { value: h.days, selected: f.horizon === h.days }, h.label),
      ),
    ),
  );

  controls.push(
    el(
      'button',
      {
        type: 'button',
        class: 'btn btn-refresh',
        'data-refresh': 'releases',
        title: 'Re-read what is on your Plex server. About fifteen seconds.',
      },
      'Refresh',
    ),
  );

  bar.replaceChildren(...controls);
  wireRefreshButtons(bar);
}

/**
 * Each tab refreshes only what it shows. The full Check for updates is still
 * there for the slow parts: episode schedules and MusicBrainz.
 */
const REFRESH_LABELS = {
  releases: 'Refresh',
  watchlist: 'Refresh watchlist',
  library: 'Re-read my library',
  music: 'Check artists',
};

function wireRefreshButtons(root = document) {
  for (const btn of root.querySelectorAll('[data-refresh]')) {
    if (btn.dataset.wired) continue;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const job = btn.dataset.refresh;
      banner('');
      try {
        await post('/api/refresh', { job });
        refreshState();
      } catch (err) {
        banner(err.message);
      }
    });
  }
}

/* -------------------------------------------------------------- releases */

async function loadReleases() {
  const view = currentView();
  try {
    const { releases } = await api(`/api/releases?view=${view}`);
    state.cache[view] = releases;
    renderReleases();
  } catch (err) {
    banner(err.message);
  }
}

function renderReleases() {
  const key = panelKey();
  const view = currentView();
  const f = state.filters[key];
  const target = key === 'upcoming' ? $('#upcoming-list') : $('#out-list');

  const all = state.cache[view] ?? [];
  const rows = groupEpisodes(applyFilters(all, f, key), key).sort(SORTS[f.sort].fn);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  target.replaceChildren();
  target.before(summaryFor(key, rows.length, all.length, f, view));

  if (all.length === 0) {
    target.append(emptyState(view));
    return;
  }
  if (rows.length === 0) {
    target.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, 'Nothing matches those filters'),
        f.types.size === 0 ? 'Turn at least one type back on.' : 'Try a different search.',
      ),
    );
    return;
  }
  const card = (r) => itemCard(r, r.first_seen_at > weekAgo, view === 'dismissed');

  // Day headings only make sense while the list is in date order. Under Title
  // A to Z they would fragment into one heading per row.
  if (!DATE_SORTS.has(f.sort)) {
    for (const r of rows) target.append(card(r));
    return;
  }
  for (const group of groupByDay(rows)) {
    target.append(dayHeadingRow(group));
    for (const r of group.items) target.append(card(r));
  }
}

const DATE_SORTS = new Set(['date-desc', 'date-asc', 'soonest']);

/** The rule above each day's cards: what day it is on the left, how far off and
 * how much landed on the right. */
function dayHeadingRow(group) {
  const relative = group.date ? relativeDays(group.date) : '';
  return el(
    'div',
    { class: 'day-head' },
    el('span', { class: 'day-name' }, dayHeading(group.date)),
    el(
      'span',
      { class: 'muted small' },
      [relative, plural(group.items.length, 'item')].filter(Boolean).join(' · '),
    ),
  );
}

function summaryFor(key, shown, total, f, view) {
  const existing = $(`#summary-${key}`);
  if (existing) existing.remove();
  const def = key === 'upcoming' ? 'soonest' : 'date-desc';
  // The count reflects whatever was actually hidden, including the default
  // horizon. The Clear button only appears for filters the user chose.
  const active = filtersActive(f, def, DEFAULT_HORIZONS[key], DEFAULT_HELD[key]);
  const narrowed = shown !== total;
  const noun = view === 'dismissed' ? 'dismissed' : 'item';
  return el(
    'div',
    { class: 'filter-summary', id: `summary-${key}` },
    el(
      'span',
      {},
      total === 0
        ? ''
        : narrowed
          ? `Showing ${shown} of ${plural(total, noun)}`
          : plural(total, noun),
    ),
    active
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn btn-tiny',
            onclick: () => {
              f.q = '';
              f.types = new Set(ALL_TYPES);
              f.sort = def;
              if (f.horizon !== undefined) f.horizon = DEFAULT_HORIZONS[key];
              f.cinema = false;
              f.held = DEFAULT_HELD[key];
              buildFilterBar(key);
              renderReleases();
            },
          },
          'Clear filters',
        )
      : null,
  );
}

/** How long an armed button waits before going back to being safe. */
const ARM_MS = 4000;

/**
 * A button that needs pressing twice.
 *
 * Dismiss is easy to hit by accident and, on a collapsed run of episodes, one
 * press can clear seven rows at once. The first press only arms the button and
 * changes the label to say what is actually about to happen, including how many
 * things it will affect. It disarms itself after a few seconds, so a button
 * armed and then forgotten does not sit waiting to fire on the next click.
 */
function confirmingButton(label, armedLabel, onConfirm, busyLabel = 'Dismissing…') {
  let timer = null;
  const btn = el('button', { class: 'btn btn-tiny' }, label);

  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('is-armed');
    btn.textContent = label;
  };

  btn.addEventListener('click', async () => {
    if (timer === null) {
      btn.classList.add('is-armed');
      btn.textContent = armedLabel;
      timer = setTimeout(disarm, ARM_MS);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.disabled = true;
    btn.textContent = busyLabel;
    await onConfirm();
  });

  return btn;
}

function itemCard(r, isNew, dismissed) {
  const card = el('article', { class: `card${dismissed ? ' is-dismissed' : ''}` });
  const toggleEpisodes = () => {
    const open = card.querySelector('.episode-list');
    if (open) {
      open.remove();
      return;
    }
    card.append(
      el(
        'div',
        { class: 'episode-list' },
        r.episodes.map((ep) =>
          el(
            'div',
            { class: 'episode-row' },
            el(
              'span',
              {},
              ep.in_library === 1
                ? el('span', { class: 'tick', title: 'On your Plex server' }, '✓ ')
                : null,
              ep.subtitle,
              NOTABLE_EVENTS.includes(ep.event) ? [' ', eventTag(ep.event)] : null,
            ),
            el(
              'span',
              { class: 'muted' },
              `${formatWhen(ep.date, ep.air_stamp)} · ${relativeWhen(ep.date, ep.air_stamp)}`,
            ),
            confirmingButton('Dismiss', 'Dismiss, sure?', async () => {
              await post('/api/releases/dismiss', {
                id: ep.id,
                source: 'episode',
                dismissed: true,
              });
              loadReleases();
              refreshState();
            }),
          ),
        ),
      ),
    );
  };

  card.append(
    artwork(r.thumb, r.title),
    el(
      'div',
      {},
      el('p', { class: 'card-title' }, r.title),
      el('p', { class: 'card-artist' }, r.subtitle || ''),
      el(
        'div',
        { class: 'card-meta' },
        r.in_library === 1
          ? el(
              'span',
              { class: 'tag held', title: 'Already on your Plex server' },
              '✓ In Plex',
            )
          : r.isGroup && r.heldCount
            ? el(
                'span',
                { class: 'tag part-held', title: 'Some of these are on your server' },
                `${r.heldCount} of ${r.episodes.length} in Plex`,
              )
            : null,
        isNew && !dismissed && r.in_library !== 1
          ? el('span', { class: 'tag new' }, 'New')
          : null,
        el('span', { class: 'tag' }, KIND_TAG[r.kind] ?? r.kind),
        eventTag(r.event),
        r.date_kind ? el('span', { class: `tag date-${r.date_kind}` }, r.date_kind) : null,
        el('span', {}, formatWhen(r.date, r.air_stamp)),
        el('span', {}, `· ${relativeWhen(r.date, r.air_stamp)}`),
      ),
    ),
    el(
      'div',
      { class: 'card-actions' },
      r.isGroup
        ? el(
            'button',
            { class: 'btn btn-tiny', onclick: toggleEpisodes },
            `${r.episodes.length} episodes`,
          )
        : null,
      el(
        'button',
        { class: 'btn btn-tiny', onclick: () => togglePlayer(r, card) },
        r.kind === 'movie' || r.kind === 'show' ? 'Trailer' : 'Play',
      ),
      r.plex_link
        ? el(
            'a',
            { class: 'link', href: r.plex_link, target: '_blank', rel: 'noreferrer' },
            'Open in Plex',
          )
        : r.link
          ? el(
              'a',
              { class: 'link', href: r.link, target: '_blank', rel: 'noreferrer' },
              r.source === 'music' ? 'MusicBrainz' : 'Plex',
            )
          : null,
      (() => {
        const targets = r.isGroup ? r.episodes : [r];
        const run = async () => {
          for (const t of targets) {
            await post('/api/releases/dismiss', {
              id: t.id,
              source: t.source,
              dismissed: !dismissed,
            });
          }
          loadReleases();
          refreshState();
        };
        // Restoring something is harmless, so it stays a single press. Only
        // dismissing asks twice, and it names the count when a press would
        // clear a whole run of episodes rather than one row.
        if (dismissed) {
          return el('button', { class: 'btn btn-tiny', onclick: run }, 'Restore');
        }
        const armed =
          targets.length > 1 ? `Dismiss all ${targets.length}?` : 'Dismiss, sure?';
        return confirmingButton('Dismiss', armed, run);
      })(),
    ),
  );
  return card;
}

/**
 * A premiere or finale is worth seeing at a glance, so each takes its own
 * colour: green for a start, warm for an end. Every other event keeps the
 * plain blue badge.
 */
function eventTag(event) {
  if (!event) return null;
  const tone = event.endsWith('finale')
    ? ' finale'
    : event.endsWith('premiere')
      ? ' premiere'
      : '';
  return el('span', { class: `tag event${tone}` }, event);
}

let lazyArtwork = null;
function artworkObserver() {
  lazyArtwork ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        lazyArtwork.unobserve(img);
        window.pmtThumbLoader(img.dataset.src).then(
          (local) => (img.src = local),
          () => img.dispatchEvent(new Event('error')),
        );
      }
    },
    { rootMargin: '200px' },
  );
  return lazyArtwork;
}

function artwork(src, name) {
  const fallback = () =>
    img.replaceWith(el('div', { class: 'art art-fallback' }, (name || '?').charAt(0).toUpperCase()));
  // The phone app cannot load /thumb as a plain image address, so it supplies
  // a loader that fetches the picture and hands back a local address.
  const loader = window.pmtThumbLoader;
  const img = el('img', { class: 'art', src: loader ? null : src, alt: '', loading: 'lazy' });
  img.addEventListener('error', fallback);
  if (loader) {
    if (!src) queueMicrotask(fallback);
    // Fetched only once on screen, the way loading="lazy" works for a plain image.
    else artworkObserver().observe(img);
    img.dataset.src = src || '';
  }
  return img;
}

function emptyState(view) {
  if (view === 'upcoming') {
    return el(
      'div',
      { class: 'empty' },
      el('strong', {}, 'Nothing announced yet'),
      'Records and films dated in the future will show up here.',
    );
  }
  if (view === 'dismissed') {
    return el('div', { class: 'empty' }, el('strong', {}, 'Nothing dismissed'));
  }
  return el(
    'div',
    { class: 'empty' },
    el('strong', {}, 'Nothing new right now'),
    'Run a scan, or widen the recent window in Settings.',
  );
}

$('#show-dismissed').addEventListener('change', loadReleases);

/* ------------------------------------------------------------- watchlist */

async function loadWatchlist() {
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
      item.public_url
        ? el(
            'a',
            { class: 'link', href: item.public_url, target: '_blank', rel: 'noreferrer' },
            'Plex',
          )
        : null,
      el(
        'button',
        {
          class: 'btn btn-tiny',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await post('/api/watchlist/remove', { rating_key: item.rating_key });
              banner(`${item.title} removed from your Plex watchlist.`, 'ok');
              loadWatchlist();
              refreshState();
            } catch (err) {
              banner(err.message);
              e.currentTarget.disabled = false;
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
$$('#wl-chips .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    const t = chip.dataset.wl;
    const set = state.wlFilters.types;
    if (set.has(t)) set.delete(t);
    else set.add(t);
    chip.classList.toggle('is-on', set.has(t));
    renderWatchlist();
  }),
);
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

/* ----------------------------------------------------------- suggestions */

async function loadSuggestions() {
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
      s.link
        ? el('a', { class: 'link', href: s.link, target: '_blank', rel: 'noreferrer' }, 'Details')
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

  const label = s.kind === 'artist' ? 'Watch artist' : 'Add to watchlist';
  return el(
    'button',
    {
      class: 'btn btn-tiny btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        try {
          const r = await post('/api/search/add', {
            kind: s.kind,
            id: s.kind === 'artist' ? s.id : s.rating_key,
            title: s.title,
          });
          banner(r.message, 'ok');
          s.tracked = true;
          renderSuggestions();
          refreshState();
        } catch (err) {
          banner(err.message);
          btn.disabled = false;
          btn.textContent = label;
        }
      },
    },
    label,
  );
}

$('#sg-filter').addEventListener('input', (e) => {
  state.sgFilters.q = e.target.value;
  renderSuggestions();
});

$('#sg-previous').addEventListener('change', (e) => {
  state.sgFilters.previousYears = e.target.checked;
  renderSuggestions();
});
$$('#sg-chips .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    const k = chip.dataset.sg;
    const set = state.sgFilters.kinds;
    if (set.has(k)) set.delete(k);
    else set.add(k);
    chip.classList.toggle('is-on', set.has(k));
    renderSuggestions();
  }),
);

$('#suggest-btn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  banner('');
  try {
    await post('/api/suggestions/build', { what: 'all' });
    pollSuggestions();
  } catch (err) {
    banner(err.message);
    e.currentTarget.disabled = false;
  }
});

async function pollSuggestions() {
  try {
    const { running, message } = await api('/api/suggestions/progress');
    $('#suggest-btn').disabled = running;
    $('#suggest-btn').textContent = running ? 'Building…' : 'Build suggestions';
    if (message) banner(message, running ? undefined : 'ok');
    if (running) setTimeout(pollSuggestions, 2000);
    else loadSuggestions();
  } catch {
    $('#suggest-btn').disabled = false;
    $('#suggest-btn').textContent = 'Build suggestions';
  }
}

/* -------------------------------------------------------------- trending */

async function loadTrending() {
  try {
    const r = await api('/api/trending');
    state.trending = r.items;
    state.trendingBuiltAt = r.built_at;
    state.trendingHasKey = r.has_tmdb_key;
    renderTrending();
  } catch (err) {
    banner(err.message);
  }
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

  const list = $('#tr-list');
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

  // One run of cards per chart, under its own heading. Without this the four
  // charts read as one flat list, so a row numbered 1 appears three or four
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

const TR_KIND_ORDER = ['movie', 'show', 'album', 'single'];
const TR_KIND_LABEL = { movie: 'Films', show: 'Shows', album: 'Albums', single: 'Singles' };

/**
 * The heading above one chart's run of cards. Built per kind rather than
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

const TR_TAG = { movie: 'film', show: 'show', album: 'album', single: 'single' };

function trendingCard(t) {
  const card = el('article', { class: 'card' });
  // Artwork always goes through the /thumb proxy, the same as every other
  // card, so the page never contacts Apple or TMDB directly.
  const art = t.thumb
    ? artwork(`/thumb?url=${encodeURIComponent(t.thumb)}`, t.title)
    : el('div', { class: 'art art-fallback' }, (t.title || '?').charAt(0).toUpperCase());

  card.append(
    art,
    el(
      'div',
      {},
      // The rank is the chart position, not the row's position in this list,
      // so it keeps counting from the real chart even when catalogue rows are
      // filtered out and the visible numbers skip.
      el('p', { class: 'card-title' }, el('span', { class: 'muted' }, `${t.rank}. `), t.title),
      el('p', { class: 'card-artist' }, t.subtitle || ''),
      el(
        'div',
        { class: 'card-meta' },
        el('span', { class: 'tag' }, TR_TAG[t.kind] ?? t.kind),
        t.release_date ? el('span', {}, formatDate(t.release_date)) : null,
        trendingHeldTag(t),
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
                kind: t.kind === 'album' || t.kind === 'single' ? 'single' : t.kind,
                title: t.title,
                subtitle: t.subtitle,
              },
              card,
            ),
        },
        t.kind === 'movie' || t.kind === 'show' ? 'Trailer' : 'Play',
      ),
      t.link
        ? el('a', { class: 'link', href: t.link, target: '_blank', rel: 'noreferrer' }, 'Details')
        : null,
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

/**
 * A film or show goes onto the real Plex watchlist. Music has no Plex
 * equivalent, so the action is to watch the artist, as Suggestions does.
 */
function trendingAction(t) {
  const isVideo = t.kind === 'movie' || t.kind === 'show';
  if (t.tracked) {
    return el('span', { class: 'tag held' }, isVideo ? '✓ On watchlist' : '✓ Watched');
  }
  // With no resolved Plex key or MusicBrainz id there is nothing to add, so
  // offer no button rather than one that would fail.
  if (isVideo && !t.rating_key) return null;
  if (!isVideo && !t.mbid) return null;

  const label = isVideo ? 'Add to watchlist' : 'Watch artist';
  return el(
    'button',
    {
      class: 'btn btn-tiny btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        try {
          const r = await post('/api/search/add', {
            kind: isVideo ? t.kind : 'artist',
            id: isVideo ? t.rating_key : t.mbid,
            title: isVideo ? t.title : t.subtitle,
          });
          banner(r.message, 'ok');
          // The chart repeats artists and films heavily (the same artist or
          // title can sit at several ranks), so marking only the clicked row
          // would leave every other occurrence still offering the button.
          for (const other of state.trending) {
            if (isVideo ? other.rating_key === t.rating_key : other.mbid === t.mbid) {
              other.tracked = true;
            }
          }
          renderTrending();
          refreshState();
        } catch (err) {
          banner(err.message);
          btn.disabled = false;
          btn.textContent = label;
        }
      },
    },
    label,
  );
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

$$('#tr-chips .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    const k = chip.dataset.tr;
    const set = state.trFilters.kinds;
    if (set.has(k)) set.delete(k);
    else set.add(k);
    chip.classList.toggle('is-on', set.has(k));
    renderTrending();
  }),
);

$('#trending-btn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try {
    await post('/api/trending/build', {});
    pollTrending();
  } catch (err) {
    banner(err.message);
    e.currentTarget.disabled = false;
  }
});

async function pollTrending() {
  try {
    const { running, message } = await api('/api/trending/progress');
    $('#trending-btn').disabled = running;
    $('#trending-btn').textContent = running ? 'Building…' : 'Build trending';
    // banner(), not #tr-summary: loadTrending() below re-renders the summary
    // line straight after this, which would overwrite it in milliseconds and
    // the finished message (in particular which chart failed and is showing
    // stale data) would never actually be read.
    if (message) banner(message, running ? undefined : 'ok');
    if (running) setTimeout(pollTrending, 1500);
    else loadTrending();
  } catch {
    $('#trending-btn').disabled = false;
    $('#trending-btn').textContent = 'Build trending';
  }
}

/* --------------------------------------------------------------- artists */

const NEEDS_ATTENTION = new Set(['ambiguous', 'not_found', 'error']);
const ARTIST_SORTS = {
  name: (a, b) => cmp(a.sort_name, b.sort_name),
  albums: (a, b) => b.album_count - a.album_count || cmp(a.sort_name, b.sort_name),
  checked: (a, b) => cmp(a.last_checked_at ?? '', b.last_checked_at ?? ''),
};

async function loadArtists() {
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
            e.currentTarget.disabled = true;
            await post('/api/artists/mute', { plex_key: a.plex_key, muted: !a.muted });
            loadArtists();
            refreshState();
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
            href: `https://musicbrainz.org/artist/${c.id}`,
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

/* -------------------------------------------------------------- settings */

async function loadSettings() {
  try {
    const response = await api('/api/settings');
    const { settings, token_set, platform, version, releases_url } = response;
    $('#android-link').href = releases_url;
    // On the phone, a button that updates in place replaces the download link.
    const updater = window.pmtUpdater;
    $('#update-row').hidden = !updater;
    $('#android-link').hidden = Boolean(updater);
    $('#android-link').textContent =
      platform === 'mobile' ? 'Check for a newer version' : 'Get the Android app';
    $('#app-version').textContent =
      platform === 'mobile'
        ? `This is version ${version}.`
        : `The Android app runs on its own on your phone, with its own library and scans. This is version ${version}.`;
    $('#plex_url').value = settings.plex_url;
    $('#plex_token').value = token_set ? '********' : '';
    const auto = settings.plex_connection === 'auto';
    $('#plex_connection_auto').checked = auto;
    $('#plex_connection_manual').checked = !auto;
    const server = $('#plex_server');
    if (settings.plex_machine_id && server.options.length <= 1) {
      server.replaceChildren(
        el('option', { value: settings.plex_machine_id, selected: true }, 'Current server'),
      );
    }
    showCurrentAddress(settings.plex_url, settings.plex_connection_kind);
    showConnectionFields();
    $('#recent_days').value = settings.recent_days;
    $('#stale_days').value = settings.stale_days;
    $('#include_album').checked = settings.include_album === '1';
    $('#include_ep').checked = settings.include_ep === '1';
    $('#include_single').checked = settings.include_single === '1';
    $('#watchlist_enabled').checked = settings.watchlist_enabled === '1';
    $('#sync_on_start').checked = settings.sync_on_start === '1';
    $('#tmdb_api_key').value = settings.tmdb_api_key === '********' ? '********' : '';

    const select = $('#plex_section');
    if (settings.plex_section && select.options.length <= 1) {
      select.replaceChildren(
        el(
          'option',
          { value: settings.plex_section, selected: true },
          settings.plex_section_title || 'Current library',
        ),
      );
    }
  } catch (err) {
    banner(err.message);
  }
}

function connectionMode() {
  return $('#plex_connection_auto').checked ? 'auto' : 'manual';
}

function showConnectionFields() {
  const auto = connectionMode() === 'auto';
  $('#plex-auto-fields').hidden = !auto;
  $('#plex-manual-fields').hidden = auto;
}

const KIND_LABELS = {
  local: 'on your home network',
  remote: 'over the internet',
  relay: 'through the Plex relay',
};

function showCurrentAddress(url, kind) {
  $('#plex-current-address').textContent =
    url && KIND_LABELS[kind] ? `Last reached at ${url}, ${KIND_LABELS[kind]}.` : '';
}

for (const radio of document.querySelectorAll('input[name="plex_connection"]')) {
  radio.addEventListener('change', showConnectionFields);
}

$('#find-servers-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#find-servers-result').textContent = 'Asking plex.tv…';
  try {
    const { servers } = await post('/api/plex/servers', {
      plex_token: $('#plex_token').value.trim(),
    });
    const select = $('#plex_server');
    const current = select.value;
    if (servers.length === 0) {
      $('#find-servers-result').textContent = 'No servers you own were found on this account.';
      return;
    }
    select.replaceChildren(...servers.map((s) => el('option', { value: s.machine_id }, s.name)));
    select.value = servers.some((s) => s.machine_id === current) ? current : servers[0].machine_id;
    $('#find-servers-result').textContent =
      `Found ${servers.length} ${servers.length === 1 ? 'server' : 'servers'}. Now test the connection.`;
  } catch (err) {
    $('#find-servers-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#test-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#test-result').textContent = 'Testing…';
  try {
    const result = await post('/api/plex/test', {
      plex_connection: connectionMode(),
      plex_machine_id: $('#plex_server').value,
      plex_url: $('#plex_url').value.trim(),
      plex_token: $('#plex_token').value.trim(),
    });
    $('#test-result').textContent = result.message;
    if (result.plex_url) {
      $('#plex_url').value = result.plex_url;
      showCurrentAddress(result.plex_url, result.kind);
    }
    if (result.sections?.length) {
      const select = $('#plex_section');
      const current = select.value;
      select.replaceChildren(...result.sections.map((s) => el('option', { value: s.key }, s.title)));
      select.value = result.sections.some((s) => s.key === current)
        ? current
        : result.sections[0].key;
    }
  } catch (err) {
    $('#test-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

let pendingUpdate = null;

$('#update-check-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#update-install-btn').hidden = true;
  $('#update-result').textContent = 'Checking…';
  try {
    const { update, installed } = await window.pmtUpdater.check();
    pendingUpdate = update;
    if (!update) {
      $('#update-result').textContent = `You have the latest version (${installed}).`;
    } else {
      $('#update-result').textContent = `Version ${update.version} is available.`;
      $('#update-install-btn').textContent = `Update to ${update.version}`;
      $('#update-install-btn').hidden = false;
    }
  } catch (err) {
    $('#update-result').textContent = `Could not check for updates: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('#update-install-btn').addEventListener('click', async (e) => {
  if (!pendingUpdate) return;
  const btn = e.currentTarget;
  const u = window.pmtUpdater;
  const { allowed } = await u.canInstall();
  if (!allowed) {
    $('#update-result').textContent =
      'Switch on "Allow from this source" in the screen that opens, come back, then press Update again.';
    await u.openInstallSettings();
    return;
  }
  btn.disabled = true;
  $('#update-result').textContent = 'Downloading…';
  try {
    await u.install(pendingUpdate.url);
    $('#update-result').textContent = 'Press Update on the screen Android shows. Your data is kept.';
  } catch (err) {
    $('#update-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#wl-test-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#wl-test-result').textContent = 'Checking…';
  try {
    const r = await post('/api/watchlist/test');
    $('#wl-test-result').textContent = r.message;
  } catch (err) {
    $('#wl-test-result').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const select = $('#plex_section');
  try {
    const saved = await post('/api/settings', {
      plex_connection: connectionMode(),
      plex_url: $('#plex_url').value.trim(),
      plex_token: $('#plex_token').value.trim(),
      plex_section: select.value,
      plex_section_title: select.selectedOptions[0]?.textContent ?? '',
      ...(connectionMode() === 'auto' && $('#plex_server').value
        ? { plex_machine_id: $('#plex_server').value }
        : {}),
      recent_days: $('#recent_days').value,
      stale_days: $('#stale_days').value,
      include_album: $('#include_album').checked ? '1' : '0',
      include_ep: $('#include_ep').checked ? '1' : '0',
      include_single: $('#include_single').checked ? '1' : '0',
      watchlist_enabled: $('#watchlist_enabled').checked ? '1' : '0',
      sync_on_start: $('#sync_on_start').checked ? '1' : '0',
      tmdb_api_key: $('#tmdb_api_key').value.trim(),
    });
    $('#save-result').textContent = saved.warning || 'Saved';
    if (!saved.warning) setTimeout(() => ($('#save-result').textContent = ''), 2500);
    refreshState();
  } catch (err) {
    $('#save-result').textContent = err.message;
  }
});

/* ------------------------------------------------------------------ scan */

$('#scan-btn').addEventListener('click', async () => {
  banner('');
  try {
    await post('/api/scan/start');
    refreshState();
  } catch (err) {
    banner(err.message);
  }
});

$('#stop-btn').addEventListener('click', () => post('/api/scan/stop').then(refreshState));

const PHASE_TEXT = {
  refresh: 'Step 1 of 2: your Plex library, watchlist, episodes and film dates',
  watchlist: 'Syncing your Plex watchlist',
  plex: 'Reading your music library',
  identify: 'Step 2 of 2: identifying artists in MusicBrainz',
  releases: 'Step 2 of 2: checking artists for new records',
};

async function refreshState() {
  try {
    const { configured, counts, progress, scans, machine_id } = await api('/api/state');
    state.machineId = machine_id ?? null;

    $('#count-out').textContent = counts.out;
    $('#count-upcoming').textContent = counts.upcoming;
    $('#count-artists').textContent = counts.artists;
    $('#count-watchlist').textContent = counts.watchlist ?? 0;

    const running = progress.running;
    $('#scan-btn').disabled = running || !configured;
    $('#scan-btn').textContent = running ? 'Checking…' : 'Check for updates';
    for (const btn of document.querySelectorAll('[data-refresh]')) {
      btn.disabled = running || !configured;
      btn.textContent = running ? 'Working…' : REFRESH_LABELS[btn.dataset.refresh] ?? 'Refresh';
    }
    $('#stop-btn').hidden = !running;
    $('#progress').hidden = !running;

    if (running) {
      $('#progress-message').textContent = PHASE_TEXT[progress.phase] || progress.message;
      $('#progress-count').textContent = progress.total
        ? `${progress.done} of ${progress.total}`
        : '';
      $('#progress-fill').style.width = progress.total
        ? `${Math.round((progress.done / progress.total) * 100)}%`
        : '4%';
      $('#progress-current').textContent = progress.current;
    }

    if (!configured) {
      banner('Plex is not set up yet. Open Settings and add your server URL and token.');
    } else if (!running && ['failed', 'stopped'].includes(progress.phase)) {
      banner(progress.message);
    } else if (!running && progress.phase === 'done' && progress.finishedAt) {
      banner(progress.message, 'ok');
    }

    if (!running && state.wasRunning) {
      if (state.tab === 'out' || state.tab === 'upcoming') loadReleases();
      if (state.tab === 'artists') loadArtists();
      if (state.tab === 'watchlist') loadWatchlist();
      if (state.tab === 'suggestions') loadSuggestions();
      if (state.tab === 'library') loadLibrary();
    }
    state.wasRunning = running;

    renderHistory(scans);
    scheduleNextPoll(running);
  } catch (err) {
    banner(err.message);
    scheduleNextPoll(false);
  }
}

function scheduleNextPoll(running) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(refreshState, running ? 1500 : 15000);
}

function renderHistory(scans) {
  const node = $('#scan-history');
  if (!node) return;
  node.replaceChildren();
  if (!scans.length) {
    node.append(el('p', { class: 'muted small' }, 'No scans yet.'));
    return;
  }
  for (const s of scans) {
    const when = new Date(s.started_at).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    node.append(
      el(
        'div',
        { class: 'scan-row' },
        el('span', {}, when),
        el('span', {}, `${s.status} · ${s.artists_seen} artists · ${s.new_releases} new`),
      ),
    );
  }
}

/* ------------------------------------------------------------------ boot */

wireRefreshButtons();
buildFilterBar('out');
buildFilterBar('upcoming');
showTab('out');
refreshState();

/* ---------------------------------------------------------------- search */

async function runSearch() {
  const q = $('#search-box').value.trim();
  if (q.length < 2) {
    state.searchHits = [];
    state.searchNotes = ['Type at least two characters.'];
    renderSearch();
    return;
  }
  if (state.searchKinds.size === 0) {
    state.searchHits = [];
    state.searchNotes = ['Turn on at least one of Films, Shows or Artists.'];
    renderSearch();
    return;
  }
  state.searchBusy = true;
  renderSearch();
  try {
    const kinds = [...state.searchKinds].join(',');
    const r = await api(`/api/search?q=${encodeURIComponent(q)}&kinds=${kinds}`);
    state.searchHits = r.hits;
    state.searchNotes = r.notes;
  } catch (err) {
    state.searchHits = [];
    state.searchNotes = [err.message];
  } finally {
    state.searchBusy = false;
    renderSearch();
  }
}

function renderSearch() {
  const list = $('#search-results');
  $('#search-summary').textContent = state.searchBusy
    ? 'Searching…'
    : state.searchHits.length
      ? plural(state.searchHits.length, 'result')
      : '';

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
    : el(
        'button',
        {
          class: 'btn btn-tiny btn-primary',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Adding…';
            try {
              const r = await post('/api/search/add', {
                kind: hit.kind,
                id: hit.id,
                title: hit.title,
              });
              banner(r.message, 'ok');
              hit.tracked = true;
              renderSearch();
              refreshState();
            } catch (err) {
              banner(err.message);
              btn.disabled = false;
              btn.textContent = hit.kind === 'artist' ? 'Watch artist' : 'Add to watchlist';
            }
          },
        },
        hit.kind === 'artist' ? 'Watch artist' : 'Add to watchlist',
      );

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
$$('#search-chips .chip').forEach((chip) =>
  chip.addEventListener('click', () => {
    const k = chip.dataset.sk;
    const set = state.searchKinds;
    if (set.has(k)) set.delete(k);
    else set.add(k);
    chip.classList.toggle('is-on', set.has(k));
  }),
);

/* ------------------------------------- shows held but not on the watchlist */

/**
 * A show can sit on the server for years without the app knowing an episode is
 * due, because episode tracking follows the watchlist rather than the library.
 * This lists the gap so it can be closed one show at a time.
 */
async function loadGaps() {
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
      el(
        'button',
        {
          class: 'btn btn-tiny btn-primary',
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Adding…';
            try {
              await post('/api/search/add', { kind: 'show', id: g.rating_key, title: g.title });
              banner(`${g.title} added to your Plex watchlist.`, 'ok');
              state.gaps = (state.gaps ?? []).filter((x) => x.rating_key !== g.rating_key);
              renderGaps();
              refreshState();
            } catch (err) {
              banner(err.message);
              btn.disabled = false;
              btn.textContent = 'Track';
            }
          },
        },
        'Track',
      ),
    ),
  );
}

$('#gaps-filter').addEventListener('input', renderGaps);

/* --------------------------------------------------------------- library */

/** A plain stat tile: one label, one number, one line of context. */
function tile(label, value, note) {
  return el(
    'div',
    { class: 'tile' },
    el('p', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, String(value)),
    el('div', { class: 'tile-note' }, note),
  );
}

const RES_LABEL = { sd: 'SD', '480': '480p', '576': '576p', '720': '720p', '1080': '1080p', '4k': '4K' };

function gb(bytes) {
  if (!bytes) return '';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** A link into the Plex app, or nothing when the server id is not known yet. */
function plexLink(url, label = 'Open in Plex') {
  if (!url) return null;
  return el('a', { class: 'link', href: url, target: '_blank', rel: 'noreferrer' }, label);
}

async function loadLibrary() {
  try {
    state.library = await api('/api/library');
    renderLibrary();
  } catch (err) {
    banner(err.message);
  }
}

function renderLibrary() {
  const r = state.library;
  if (!r) return;

  $('#lib-tiles').replaceChildren(
    tile('Missing episodes', r.missingCount, `across ${plural(r.missing.length, 'season')}`),
    tile('Duplicate files', r.duplicates.length, 'more than one copy held'),
    tile('Below 1080p', r.upgrades.length, 'films worth replacing'),
    tile(
      'Film quality',
      r.resolutions.find((x) => x.resolution === '1080')?.n ?? 0,
      r.resolutions.map((x) => `${RES_LABEL[x.resolution] ?? x.resolution} ${x.n}`).join(' · '),
    ),
  );

  renderMissing();

  $('#dupes-list').replaceChildren(
    ...(r.duplicates.length
      ? r.duplicates.slice(0, 200).map((d) =>
          simpleRow(
            d.title,
            [
              d.season != null ? `S${String(d.season).padStart(2, '0')}E${String(d.episode).padStart(2, '0')}` : d.year,
              `${d.file_count} files`,
              RES_LABEL[String(d.resolution)] ?? d.resolution,
              gb(d.size),
            ],
            d.rating_key,
          ),
        )
      : [el('div', { class: 'empty' }, el('strong', {}, 'No duplicates'), 'Nothing is held twice.')]),
  );

  const totalLow = r.upgrades.length;
  $('#upgrade-sub').textContent = totalLow
    ? `Films held below 1080p. ${plural(totalLow, 'film')} could be replaced.`
    : 'Films held below 1080p.';

  $('#upgrades-list').replaceChildren(
    ...(totalLow
      ? r.upgrades.slice(0, 200).map((u) =>
          simpleRow(u.title, [u.year, RES_LABEL[String(u.resolution)] ?? u.resolution, u.codec, gb(u.size)], u.rating_key),
        )
      : [el('div', { class: 'empty' }, el('strong', {}, 'Nothing to upgrade'), 'Every film is 1080p or better.')]),
  );
}

function renderMissing() {
  const r = state.library;
  if (!r) return;
  const q = fold($('#miss-filter').value).trim();
  const rows = r.missing.filter((m) => !q || fold(m.show).includes(q));

  const list = $('#missing-list');
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty' },
        el('strong', {}, r.missing.length ? 'Nothing matches' : 'No holes found'),
        r.missing.length ? '' : 'Every season you hold runs without a gap.',
      ),
    );
    return;
  }
  for (const m of rows.slice(0, 300)) {
    const eps = m.missing
      .map((n) => `E${String(n).padStart(2, '0')}`)
      .join(', ');
    list.append(
      el(
        'div',
        { class: 'artist-row' },
        el('div', { class: 'art art-fallback' }, (m.show || '?').charAt(0).toUpperCase()),
        el(
          'div',
          {},
          el('div', { class: 'artist-name' }, `${m.show} · Season ${m.season}`),
          el('div', { class: 'artist-sub' }, `${plural(m.missing.length, 'episode')} missing: ${eps}`),
        ),
        el(
          'div',
          { class: 'card-actions' },
          el(
            'span',
            { class: m.reason === 'gap' ? 'tag part-held' : 'tag' },
            m.reason === 'gap' ? 'gap' : 'aired, not held',
          ),
          plexLink(m.rating_key ? plexHref(m.rating_key) : null),
        ),
      ),
    );
  }
  if (rows.length > 300) {
    list.append(el('p', { class: 'muted small' }, `Showing the first 300 of ${rows.length}.`));
  }
}

function simpleRow(title, bits, ratingKey) {
  return el(
    'div',
    { class: 'artist-row' },
    el('div', { class: 'art art-fallback' }, (title || '?').charAt(0).toUpperCase()),
    el(
      'div',
      {},
      el('div', { class: 'artist-name' }, title),
      el('div', { class: 'artist-sub' }, bits.filter(Boolean).join(' · ')),
    ),
    el('div', { class: 'card-actions' }, plexLink(ratingKey ? plexHref(ratingKey) : null)),
  );
}

/** Built here so the server id only has to travel once, on /api/state. */
function plexHref(ratingKey) {
  if (!state.machineId || !ratingKey) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${state.machineId}/details?key=${key}`;
}

$('#miss-filter').addEventListener('input', renderMissing);

/* -------------------------------------------------------------- dashboard */


function loadDash() {
  refreshNowPlaying();
  loadDashLibrary();
  loadHistory();
}

function stopNowPlaying() {
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

    list.replaceChildren(
      ...(streams.length
        ? streams.map(streamRow)
        : [el('div', { class: 'empty' }, el('strong', {}, 'All quiet'), 'Nobody is watching or listening right now.')]),
    );
  } catch (err) {
    $('#np-summary').textContent = '';
    dashError(list, err);
  }
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
    strip.replaceChildren(
      ...(added.length
        ? added.map((a) => {
            const href = plexHref(a.rating_key);
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
