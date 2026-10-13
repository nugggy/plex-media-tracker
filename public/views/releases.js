/**
 * Out now and Coming soon: the filter bar and the release cards.
 */

import {
  ALL_TYPES,
  TYPE_LABELS,
  KIND_TAG,
  NOTABLE_EVENTS,
  HORIZONS,
  DEFAULT_HORIZONS,
  DEFAULT_HELD,
  SORTS,
  plural,
  relativeDays,
  formatWhen,
  relativeWhen,
  filtersActive,
  applyFilters,
  groupEpisodes,
  groupByDay,
  dayHeading,
  formatPartialDate,
} from '../feed.js';
import { $, banner, debounce, el, safeHref } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import {
  artwork,
  confirmingButton,
  eventTag,
  releaseArtwork,
  setChip,
  togglePlayer,
} from '../components.js';
import { refreshState, wireRefreshButtons } from './status.js';

/* --------------------------------------------------------- release filters */

const panelKey = () => (state.tab === 'upcoming' ? 'upcoming' : 'out');
const currentView = () =>
  state.tab === 'upcoming' ? 'upcoming' : $('#show-dismissed').checked ? 'dismissed' : 'out';

export function buildFilterBar(key) {
  const f = state.filters[key];
  const bar = $(`#filters-${key}`);
  const sortOptions =
    key === 'upcoming'
      ? ['soonest', 'date-desc', 'name', 'title']
      : ['date-desc', 'date-asc', 'name', 'title'];

  // A big Out now list takes a moment to redraw, so wait for a pause in typing.
  const redraw = debounce(renderReleases, 150);
  const search = el('input', {
    type: 'search',
    class: 'input search',
    placeholder: 'Search titles, artists or films',
    'aria-label': 'Search titles, artists or films',
    autocomplete: 'off',
    value: f.q,
    oninput: (e) => {
      f.q = e.target.value;
      redraw();
    },
  });

  // Toggled in place rather than by rebuilding the bar, so the pressed chip
  // keeps keyboard focus.
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
          onclick: (e) => {
            if (f.types.has(type)) f.types.delete(type);
            else f.types.add(type);
            setChip(e.currentTarget, f.types.has(type));
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

/* -------------------------------------------------------------- releases */

export async function loadReleases() {
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

  releaseArtwork(target);
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
  const partial = group.precision && group.precision !== 'day';
  const relative = group.date && !partial ? relativeDays(group.date) : '';
  return el(
    'div',
    { class: 'day-head' },
    el('span', { class: 'day-name' }, dayHeading(group.date, undefined, group.precision)),
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
              // This button goes with the summary it sat in, so focus moves
              // to the start of the rebuilt filter bar instead of the page.
              $(`#filters-${key} .search`)?.focus();
            },
          },
          'Clear filters',
        )
      : null,
  );
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
    // Films and shows have 2:3 posters, and a square box would crop the title off them.
    artwork(r.thumb, r.title, r.kind === 'movie' || r.kind === 'show'),
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
        ...(formatPartialDate(r.date, r.date_precision)
          ? [el('span', { title: 'MusicBrainz has not announced the day' }, formatPartialDate(r.date, r.date_precision))]
          : [
              el('span', {}, formatWhen(r.date, r.air_stamp)),
              el('span', {}, `· ${relativeWhen(r.date, r.air_stamp)}`),
            ]),
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
      safeHref(r.plex_link)
        ? el(
            'a',
            { class: 'link', href: safeHref(r.plex_link), target: '_blank', rel: 'noreferrer' },
            'Open in Plex',
          )
        : safeHref(r.link)
          ? el(
              'a',
              { class: 'link', href: safeHref(r.link), target: '_blank', rel: 'noreferrer' },
              r.source === 'music' ? 'MusicBrainz' : 'Plex',
            )
          : null,
      (() => {
        const targets = r.isGroup ? r.episodes : [r];
        // Each row is its own request, so one failing part way through a run
        // of episodes leaves the rest done. Carry on, say how many failed, and
        // redraw so the list shows what actually changed.
        const run = async () => {
          let failed = 0;
          let lastError = null;
          for (const t of targets) {
            try {
              await post('/api/releases/dismiss', {
                id: t.id,
                source: t.source,
                dismissed: !dismissed,
              });
            } catch (err) {
              failed += 1;
              lastError = err;
            }
          }
          loadReleases();
          refreshState();
          if (failed === 0) return;
          const verb = dismissed ? 'restored' : 'dismissed';
          throw new Error(
            targets.length === 1
              ? lastError.message
              : `${failed} of ${targets.length} could not be ${verb}: ${lastError.message}`,
          );
        };
        // Restoring something is harmless, so it stays a single press. Only
        // dismissing asks twice, and it names the count when a press would
        // clear a whole run of episodes rather than one row.
        if (dismissed) {
          return el(
            'button',
            {
              class: 'btn btn-tiny',
              onclick: async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                try {
                  await run();
                } catch (err) {
                  banner(err.message);
                  btn.disabled = false;
                }
              },
            },
            'Restore',
          );
        }
        const armed =
          targets.length > 1 ? `Dismiss all ${targets.length}?` : 'Dismiss, sure?';
        return confirmingButton('Dismiss', armed, run);
      })(),
    ),
  );
  return card;
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
