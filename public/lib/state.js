/**
 * Everything the page remembers between redraws, in one object every view
 * reads and writes.
 */

import { ALL_TYPES, DEFAULT_HORIZONS, DEFAULT_HELD } from '../feed.js';

export const state = {
  tab: 'out',
  artists: [],
  watchlist: [],
  removals: [],
  suggestions: [],
  expanded: null,
  pollTimer: null,
  wasRunning: false,
  // The finishedAt of the last sync whose result the banner has reported, so
  // each run is reported once rather than on every poll.
  shownFinishedAt: null,
  // The standing warning (not set up, restart needed) last shown, if any.
  standingBanner: null,
  // The current step's start, for the time-left estimate.
  step: null,
  cache: { out: [], upcoming: [], dismissed: [] },
  // Which feeds have been read at least once, so a badge can count from them.
  cacheLoaded: { out: false, upcoming: false, dismissed: false },
  // The counts from the last /api/state, for badges on feeds not yet read.
  serverCounts: null,
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
  artistFilters: { q: '', status: 'active', sort: 'name' },
  // How many rows the long lists draw before offering Show more.
  limits: { watchlist: 100, artists: 100, upgrades: 100 },
  wlFilters: { q: '', types: new Set(['movie', 'show']), sort: 'title' },
  sgFilters: { q: '', kinds: new Set(['artist', 'movie', 'show']), previousYears: false },
  trending: [],
  trendingBuiltAt: null,
  trendingHasKey: true,
  // The charts are old enough to rebuild, or a rebuild is under way.
  trendingStale: false,
  trendingBuilding: false,
  trFilters: { q: '', kinds: new Set(['movie', 'show', 'album']), catalogue: false, held: 'all' },
  searchKinds: new Set(['movie', 'show', 'artist']),
  searchHits: [],
  searchNotes: [],
  searchBusy: false,
  gaps: null,
  library: null,
  machineId: null,
  lyrics: {
    artistsLoaded: false,
    artist: '',
    album: '',
    tracks: [],
    missingOnly: false,
    // A track list is on its way, so the one in hand is out of date.
    loading: false,
    // The last track list could not be read.
    failed: false,
    // A Find lyrics or Save to Plex job is running on the server.
    jobRunning: false,
    // How many cards the list draws before offering Show more.
    limit: 300,
  },
  friends: {
    listLoaded: false,
    friend: 'all',
    items: [],
    notes: [],
    filters: { q: '', kinds: new Set(['movie', 'show']), hideHeld: true },
  },
  // The Dashboard's refresh timer, and which stream's Stop is waiting for a second press.
  // loading and again stop two refresh loops running side by side.
  dash: { timer: null, stopArmed: null, loading: false, again: false },
};

/**
 * A choice worth keeping between visits, such as which artists the list
 * shows. Browser storage can be missing or blocked (a private window, the
 * phone app's WebView with storage cleared), so every read and write is
 * guarded and a failure simply falls back to the default.
 */
const PREF_PREFIX = 'pmt.';

export function loadPref(key, fallback, allowed = null) {
  try {
    const raw = window.localStorage.getItem(PREF_PREFIX + key);
    if (raw === null) return fallback;
    const value = JSON.parse(raw);
    return allowed && !allowed.includes(value) ? fallback : value;
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    window.localStorage.setItem(PREF_PREFIX + key, JSON.stringify(value));
  } catch {
    // Not kept, which only means the default comes back next time.
  }
}
