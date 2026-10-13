/**
 * The scan and refresh buttons, the progress bar and the banner that
 * reports how a sync went. refreshState polls the server and redraws the
 * counts on the tabs.
 */

import { $, banner, el } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { state } from '../lib/state.js';
import { loadArtists } from './artists.js';
import { loadLibrary } from './library.js';
import { loadReleases } from './releases.js';
import { loadSuggestions } from './suggestions.js';
import { loadWatchlist } from './watchlist.js';

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

export function wireRefreshButtons(root = document) {
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

$('#stop-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await post('/api/scan/stop');
    refreshState();
  } catch (err) {
    banner(err.message);
  } finally {
    btn.disabled = false;
  }
});

const PHASE_TEXT = {
  refresh: 'Step 1 of 2: your Plex library, watchlist, episodes and film dates',
  watchlist: 'Syncing your Plex watchlist',
  plex: 'Reading your music library',
  identify: 'Step 2 of 2: identifying artists in MusicBrainz',
  releases: 'Step 2 of 2: checking artists for new records',
};

export async function refreshState() {
  try {
    const { configured, counts, progress, scans, machine_id, restart_needed } = await api('/api/state');
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
      $('#progress-eta').textContent = timeLeftText(progress);
    } else {
      state.step = null;
    }

    // The two standing problems are repeated on every poll, since they hold
    // until fixed. A finished sync is reported once per run: this poll repeats
    // every fifteen seconds, and repeating the result would write over
    // whatever else the banner has said since, an error included.
    const standing = restart_needed
      ? 'The app has been updated. Close its window and open it again to finish, or new buttons will not work.'
      : !configured
        ? 'Plex is not set up yet. Open Settings and add your server URL and token.'
        : null;
    if (standing) {
      banner(standing);
    } else if ($('#banner').textContent === state.standingBanner && !$('#banner').hidden) {
      // Fixed since the last poll, so the warning goes.
      banner('');
    }
    state.standingBanner = standing;

    const finished = !running && progress.finishedAt && progress.finishedAt !== state.shownFinishedAt;
    if (!standing && finished) {
      if (['failed', 'stopped'].includes(progress.phase)) {
        banner(progress.reason || progress.message);
      } else if (progress.phase === 'done') {
        banner('Sync successful.', 'ok');
      }
    }
    if (!running) state.shownFinishedAt = progress.finishedAt ?? null;

    if (!running && state.wasRunning) {
      if (state.tab === 'out' || state.tab === 'upcoming') loadReleases();
      if (state.tab === 'artists') loadArtists();
      if (state.tab === 'watchlist') loadWatchlist();
      if (state.tab === 'suggestions') loadSuggestions();
      if (state.tab === 'housekeeping') loadLibrary();
    }
    state.wasRunning = running;

    renderHistory(scans);
    scheduleNextPoll(running);
  } catch (err) {
    banner(err.message);
    scheduleNextPoll(false);
  }
}

/**
 * A rough time left. A step with a count (artists checked so far) is timed
 * from its own pace; otherwise the last good run of the same kind sets the
 * expectation. Neither is exact, so it is always worded as "about".
 */
function timeLeftText(progress) {
  const now = Date.now();
  const elapsed = (now - Date.parse(progress.startedAt)) / 1000;

  // Restart the step clock whenever the phase changes or the count goes back.
  const step = state.step;
  if (!step || step.phase !== progress.phase || progress.done < step.done) {
    state.step = { phase: progress.phase, at: now, done: progress.done };
  }
  let stepLeft = null;
  const counted = progress.done - state.step.done;
  const stepSeconds = (now - state.step.at) / 1000;
  if (progress.total > 0 && counted >= 2 && stepSeconds >= 5) {
    stepLeft = ((progress.total - progress.done) * stepSeconds) / counted;
  }

  let left = null;
  if (progress.phase === 'releases' && stepLeft !== null) left = stepLeft;
  else if (progress.expectedSeconds) left = Math.max(progress.expectedSeconds - elapsed, stepLeft ?? 0);
  else left = stepLeft;

  const soFar = `${formatDuration(elapsed)} so far`;
  if (left === null) return `${soFar}. Working out how long is left.`;
  if (left < 15) return `${soFar}. Nearly done.`;
  return `${soFar}. About ${formatDuration(left)} to go, roughly ${formatDuration(elapsed + left)} in all.`;
}

function formatDuration(seconds) {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
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
