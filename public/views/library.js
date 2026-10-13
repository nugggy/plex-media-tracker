/**
 * Library, Housekeeping: missing episodes, duplicates and upgrades.
 */

import { fold, plural } from '../feed.js';
import { $, banner, el } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state } from '../lib/state.js';
import { plexHref, plexLink, tile } from '../components.js';

const RES_LABEL = { sd: 'SD', '480': '480p', '576': '576p', '720': '720p', '1080': '1080p', '4k': '4K' };

function gb(bytes) {
  if (!bytes) return '';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export async function loadLibrary() {
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

$('#miss-filter').addEventListener('input', renderMissing);
