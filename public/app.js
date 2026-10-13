/**
 * The page's entry point. It holds the tab router and starts the app; each
 * tab's own code lives under views/, shared pieces in components.js and lib/.
 * The views are imported first, so by the time the start-up code at the end
 * runs, every module has finished loading.
 */

import { $, $$ } from './lib/dom.js';
import { resumeIfRunning } from './lib/api.js';
import { state } from './lib/state.js';
import { loadArtists } from './views/artists.js';
import { loadDash, stopNowPlaying } from './views/dash.js';
import { loadFriends } from './views/friends.js';
import { loadLibrary } from './views/library.js';
import { loadLyrics, lyricsPoll } from './views/lyrics.js';
import { buildFilterBar, loadReleases, prefetchFeed } from './views/releases.js';
import { renderSearch } from './views/search.js';
import { loadSettings, warnIfUnsaved } from './views/settings.js';
import { refreshState, wireRefreshButtons } from './views/status.js';
import { loadSuggestions, suggestionsPoll } from './views/suggestions.js';
import { loadTrending, trendingPoll } from './views/trending.js';
import { loadGaps, loadWatchlist } from './views/watchlist.js';

/* ------------------------------------------------------------------ tabs */

/**
 * Three top tabs hold several views each, chosen by a row of sub-tabs inside
 * the panel. state.tab is always the view being shown (watchlist, lyrics and
 * so on), never the group, so the rest of the app can keep asking which view
 * is open without knowing how the tab bar is arranged. Each group remembers
 * its last view, so coming back to Following lands on Artists if that is
 * where you were.
 */
const TAB_GROUPS = {
  following: ['watchlist', 'artists'],
  discover: ['suggestions', 'trending', 'friends', 'search'],
  library: ['housekeeping', 'lyrics'],
};

const groupOf = {};
for (const [group, views] of Object.entries(TAB_GROUPS)) {
  for (const view of views) groupOf[view] = group;
}

const lastView = Object.fromEntries(
  Object.entries(TAB_GROUPS).map(([group, views]) => [group, views[0]]),
);

/** The tabs the phone's More page leads to, so More stays lit while one is open. */
const UNDER_MORE = new Set(['more', 'discover', 'library', 'settings']);

function showTab(name) {
  const view = TAB_GROUPS[name] ? lastView[name] : name;
  const group = groupOf[view];
  if (group) lastView[group] = view;
  const top = group ?? view;
  if (state.tab === 'settings' && view !== 'settings') warnIfUnsaved();
  state.tab = view;
  $$('.tab').forEach((t) => markTab(t, t.dataset.tab === top));
  $$('.bnav-tab').forEach((t) =>
    markTab(t, t.dataset.tab === top || (t.dataset.tab === 'more' && UNDER_MORE.has(top))),
  );
  $$('.panel').forEach((p) => {
    p.hidden = p.id !== `panel-${top}`;
  });
  if (group) {
    const panel = $(`#panel-${group}`);
    panel.querySelectorAll('.subtab').forEach((t) => markTab(t, t.dataset.sub === view));
    panel.querySelectorAll('.subpanel').forEach((p) => {
      p.hidden = p.id !== `panel-${view}`;
    });
  }
  if (view === 'search') renderSearch();
  if (view === 'housekeeping') loadLibrary();
  if (view === 'dash') loadDash();
  else stopNowPlaying();
  if (view === 'out' || view === 'upcoming') loadReleases();
  if (view === 'watchlist') {
    loadWatchlist();
    loadGaps();
  }
  if (view === 'artists') loadArtists();
  if (view === 'suggestions') {
    loadSuggestions();
    resumeIfRunning('/api/suggestions/progress', suggestionsPoll);
  }
  if (view === 'trending') {
    loadTrending();
    resumeIfRunning('/api/trending/progress', trendingPoll);
  }
  if (view === 'lyrics') {
    loadLyrics();
    resumeIfRunning('/api/lyrics/progress', lyricsPoll);
  }
  if (view === 'friends') loadFriends();
  if (view === 'settings') loadSettings();
}

/** Only the selected tab sits in the Tab order; the arrow keys reach the rest. */
function markTab(tab, selected) {
  tab.classList.toggle('is-active', selected);
  tab.setAttribute('aria-selected', String(selected));
  tab.tabIndex = selected ? 0 : -1;
}

/**
 * Left and Right step along a tab row, wrapping at the ends, and Home and End
 * jump to either end. The tab moved to opens straight away, the same as a click.
 */
function wireTabKeys(list, selector, nameOf) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll(selector)];
    const at = tabs.indexOf(document.activeElement);
    if (at === -1) return;
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    tabs[next].focus();
    showTab(nameOf(tabs[next]));
  });
}

$$('.tab, .bnav-tab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
$$('.subtab').forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.sub)));
wireTabKeys($('.tabs'), '.tab', (t) => t.dataset.tab);
wireTabKeys($('.bottomnav'), '.bnav-tab', (t) => t.dataset.tab);

// The phone's More page lists the three tabs that do not fit along the bottom.
$$('.more-item').forEach((item) =>
  item.addEventListener('click', () => {
    showTab(item.dataset.go);
    $(`#panel-${item.dataset.go}`)?.querySelector('[role="tab"][tabindex="0"], button, input, select')?.focus();
  }),
);

// More exists only at phone width. Widening the window while it is open
// would leave a page no top tab leads to, so it goes back to Out now.
const phoneWidth = window.matchMedia('(max-width: 700px)');
phoneWidth.addEventListener('change', () => {
  if (!phoneWidth.matches && state.tab === 'more') showTab('out');
});
$$('.subtabs').forEach((list) => wireTabKeys(list, '.subtab', (t) => t.dataset.sub));

/* ------------------------------------------------------------------ boot */

wireRefreshButtons();
buildFilterBar('out');
buildFilterBar('upcoming');
showTab('out');
refreshState();
// Read Coming soon now as well, so its badge counts what the tab will show
// before it is ever opened.
prefetchFeed('upcoming');
