/**
 * Settings.
 */

import { $, banner, el, safeHref } from '../lib/dom.js';
import { api, post } from '../lib/api.js';
import { refreshState } from './status.js';

/* -------------------------------------------------------------- settings */

export async function loadSettings() {
  try {
    const response = await api('/api/settings');
    const { settings, token_set, platform, version, releases_url } = response;
    const releasesHref = safeHref(releases_url);
    if (releasesHref) $('#android-link').href = releasesHref;
    else $('#android-link').removeAttribute('href');
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

    // A section with unsaved edits keeps them. Coming back to the tab reads
    // the settings again, and that must not quietly undo what was typed.
    if (!isDirty('plex')) fillPlex(settings, token_set);
    if (!isDirty('watchlist')) {
      $('#watchlist_enabled').checked = settings.watchlist_enabled === '1';
      $('#sync_on_start').checked = settings.sync_on_start === '1';
    }
    if (!isDirty('films')) {
      $('#tmdb_api_key').value = settings.tmdb_api_key === '********' ? '********' : '';
    }
    if (!isDirty('music')) {
      $('#recent_days').value = settings.recent_days;
      $('#stale_days').value = settings.stale_days;
      $('#include_album').checked = settings.include_album === '1';
      $('#include_ep').checked = settings.include_ep === '1';
    }
    for (const section of Object.keys(SECTIONS)) {
      if (!isDirty(section)) snapshot(section);
    }
    showUnits();
    showDirty();
  } catch (err) {
    banner(err.message);
  }
}

function fillPlex(settings, tokenSet) {
  $('#plex_url').value = settings.plex_url;
  $('#plex_token').value = tokenSet ? '********' : '';
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
}

/* ---------------------------------------------------- saving by section */

/**
 * Each fieldset saves on its own, posting only its own keys; the server leaves
 * every key it is not sent as it was. That way a half-typed Plex address cannot
 * ride along when you only meant to change how far back Out now looks.
 */
const SECTIONS = {
  plex: () => {
    const select = $('#plex_section');
    return {
      plex_connection: connectionMode(),
      plex_url: $('#plex_url').value.trim(),
      plex_token: $('#plex_token').value.trim(),
      plex_section: select.value,
      plex_section_title: select.selectedOptions[0]?.textContent ?? '',
      ...(connectionMode() === 'auto' && $('#plex_server').value
        ? { plex_machine_id: $('#plex_server').value }
        : {}),
    };
  },
  watchlist: () => ({
    watchlist_enabled: $('#watchlist_enabled').checked ? '1' : '0',
    sync_on_start: $('#sync_on_start').checked ? '1' : '0',
  }),
  films: () => ({
    tmdb_api_key: $('#tmdb_api_key').value.trim(),
  }),
  music: () => ({
    include_album: $('#include_album').checked ? '1' : '0',
    include_ep: $('#include_ep').checked ? '1' : '0',
    recent_days: $('#recent_days').value,
    stale_days: $('#stale_days').value,
  }),
};

/** What each section held when it was last loaded or saved. */
const savedValues = {};

const snapshot = (section) => (savedValues[section] = JSON.stringify(SECTIONS[section]()));
const isDirty = (section) =>
  savedValues[section] !== undefined && savedValues[section] !== JSON.stringify(SECTIONS[section]());
const fieldsetOf = (section) => document.querySelector(`fieldset[data-section="${section}"]`);
const sectionName = (section) => fieldsetOf(section)?.querySelector('legend')?.textContent ?? section;

/** The sections with changes not yet saved, by their headings. */
function dirtyNames() {
  return Object.keys(SECTIONS).filter(isDirty).map(sectionName);
}

function joinNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Each Save button is live only while its section differs from what was
 * saved, and the notice at the top names every section still waiting.
 */
function showDirty() {
  for (const section of Object.keys(SECTIONS)) {
    const btn = document.querySelector(`[data-save="${section}"]`);
    if (btn && !btn.classList.contains('is-busy')) btn.disabled = !isDirty(section);
  }
  const names = dirtyNames();
  const notice = $('#settings-unsaved');
  notice.hidden = names.length === 0;
  notice.textContent = names.length ? `Unsaved changes in ${joinNames(names)}.` : '';
}

/** "1 day", "2 days": the word after each number box follows the number. */
function showUnits() {
  for (const unit of document.querySelectorAll('[data-unit]')) {
    const value = Number($(`#${unit.dataset.unit}`).value);
    unit.textContent = value === 1 ? 'day' : 'days';
  }
}

/**
 * Called when the page moves off Settings. The edits stay in the form, so this
 * only says so, in the banner rather than a dialog that would block the move.
 */
export function warnIfUnsaved() {
  const names = dirtyNames();
  if (!names.length) return;
  banner(
    `Settings has unsaved changes in ${joinNames(names)}. They stay in the form until you save them or reload the page.`,
    'info',
  );
}

async function saveSection(section) {
  const fieldset = fieldsetOf(section);
  const btn = fieldset.querySelector(`[data-save="${section}"]`);
  const result = fieldset.querySelector(`[data-result="${section}"]`);
  // The form skips the browser's own checks, since one bad box would otherwise
  // block saving every other section. Each section checks its own boxes.
  for (const field of fieldset.querySelectorAll('input, select')) {
    if (!field.checkValidity()) {
      field.reportValidity();
      field.focus();
      return;
    }
  }
  const payload = SECTIONS[section]();
  btn.disabled = true;
  btn.classList.add('is-busy');
  result.textContent = 'Saving…';
  try {
    const saved = await post('/api/settings', payload);
    savedValues[section] = JSON.stringify(payload);
    result.textContent = saved.warning || 'Saved';
    if (!saved.warning) {
      setTimeout(() => {
        if (result.textContent === 'Saved') result.textContent = '';
      }, 2500);
    }
    if (section === 'plex') {
      // Automatic mode looks the address up as it saves, so show where the
      // server was found.
      try {
        const { settings } = await api('/api/settings');
        showCurrentAddress(settings.plex_url, settings.plex_connection_kind);
      } catch {
        // The address line is a nicety; the save itself went through.
      }
    }
    refreshState();
  } catch (err) {
    result.textContent = err.message;
  } finally {
    btn.classList.remove('is-busy');
    showDirty();
  }
}

for (const section of Object.keys(SECTIONS)) {
  const fieldset = fieldsetOf(section);
  fieldset.addEventListener('input', () => {
    showUnits();
    showDirty();
  });
  fieldset.addEventListener('change', showDirty);
  fieldset.querySelector(`[data-save="${section}"]`).addEventListener('click', () => saveSection(section));
}

// Enter in a box saves the section that box belongs to, as a form would.
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const section = document.activeElement?.closest('fieldset[data-section]')?.dataset.section;
  if (section && isDirty(section)) saveSection(section);
});

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
    showDirty();
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
    showDirty();
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
  btn.disabled = true;
  try {
    const { allowed } = await u.canInstall();
    if (!allowed) {
      $('#update-result').textContent =
        'Switch on "Allow from this source" in the screen that opens, come back, then press Update again.';
      await u.openInstallSettings();
      return;
    }
    $('#update-result').textContent = 'Downloading…';
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
