/**
 * Pieces more than one view draws: artwork, the YouTube player, the press
 * twice button, filter chips, the Add to watchlist button, stat tiles and
 * links into Plex.
 */

import { $$, banner, el, safeHref } from './lib/dom.js';
import { api, post } from './lib/api.js';
import { state } from './lib/state.js';
import { refreshState } from './views/status.js';

/* -------------------------------------------------------- youtube player */

/**
 * The embed is built only when asked for, so opening a tab never loads dozens
 * of iframes at once.
 */
export async function togglePlayer(item, card) {
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
            safeHref(r.search_url)
              ? el(
                  'a',
                  { class: 'link', href: safeHref(r.search_url), target: '_blank', rel: 'noreferrer' },
                  'Wrong one?',
                )
              : null,
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
        safeHref(r.search_url)
          ? el(
              'a',
              { class: 'link', href: safeHref(r.search_url), target: '_blank', rel: 'noreferrer' },
              'Search YouTube',
            )
          : null,
      );
    }
  } catch (err) {
    holder.replaceChildren(el('div', { class: 'muted small' }, err.message));
  }
}

/** How long an armed button waits before going back to being safe. */
export const ARM_MS = 4000;

/**
 * A button that needs pressing twice.
 *
 * Dismiss is easy to hit by accident and, on a collapsed run of episodes, one
 * press can clear seven rows at once. The first press only arms the button and
 * changes the label to say what is actually about to happen, including how many
 * things it will affect. It disarms itself after a few seconds, so a button
 * armed and then forgotten does not sit waiting to fire on the next click.
 */
export function confirmingButton(label, armedLabel, onConfirm, busyLabel = 'Dismissing…') {
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
    try {
      await onConfirm();
    } catch (err) {
      banner(err.message);
      disarm();
      btn.disabled = false;
    }
  });

  return btn;
}

/** Shows a filter chip as on or off, for sight and for screen readers. */
export function setChip(chip, on) {
  chip.classList.toggle('is-on', on);
  chip.setAttribute('aria-pressed', String(on));
}

/**
 * The static chip rows in the page: each chip's data attribute names the
 * value it adds to or takes from the set, then onChange redraws.
 */
export function wireChips(selector, attr, getSet, onChange = () => {}) {
  $$(`${selector} .chip`).forEach((chip) => {
    const value = chip.dataset[attr];
    setChip(chip, getSet().has(value));
    chip.addEventListener('click', () => {
      const set = getSet();
      if (set.has(value)) set.delete(value);
      else set.add(value);
      setChip(chip, set.has(value));
      onChange();
    });
  });
}

/**
 * The Add to watchlist (or Watch artist, or Track) button. It posts to
 * /api/search/add, shows the server's message or the one given, then calls
 * onAdded so the list can redraw with the item marked as followed. On failure
 * the button comes back as it was.
 */
export function addToWatchlistButton({ label, payload, onAdded, message = null }) {
  return el(
    'button',
    {
      class: 'btn btn-tiny btn-primary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Adding…';
        try {
          const r = await post('/api/search/add', payload);
          banner(message ?? r.message, 'ok');
          onAdded();
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

/**
 * A premiere or finale is worth seeing at a glance, so each takes its own
 * colour: green for a start, warm for an end. Every other event keeps the
 * plain blue badge.
 */
export function eventTag(event) {
  if (!event) return null;
  const tone = event.endsWith('finale')
    ? ' finale'
    : event.endsWith('premiere')
      ? ' premiere'
      : '';
  return el('span', { class: `tag event${tone}` }, event);
}

let lazyArtwork = null;

/**
 * Stops watching the pictures inside root, called just before a list is
 * redrawn so the images it throws away are not kept alive by the observer.
 * Only the phone app uses the observer; on the PC this does nothing.
 */
export function releaseArtwork(root) {
  if (!lazyArtwork || !root) return;
  for (const img of root.querySelectorAll('img[data-src]')) lazyArtwork.unobserve(img);
}

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

export function artwork(src, name, poster = false) {
  const cls = poster ? 'art art-poster' : 'art';
  const fallback = () =>
    img.replaceWith(el('div', { class: `${cls} art-fallback` }, (name || '?').charAt(0).toUpperCase()));
  // The phone app cannot load /thumb as a plain image address, so it supplies
  // a loader that fetches the picture and hands back a local address.
  const loader = window.pmtThumbLoader;
  const img = el('img', { class: cls, src: loader ? null : src, alt: '', loading: 'lazy' });
  img.addEventListener('error', fallback);
  if (loader) {
    if (!src) queueMicrotask(fallback);
    // Fetched only once on screen, the way loading="lazy" works for a plain image.
    else artworkObserver().observe(img);
    img.dataset.src = src || '';
  }
  return img;
}

/* ------------------------------------------------------- tiles and links */

/** A plain stat tile: one label, one number, one line of context. */
export function tile(label, value, note) {
  return el(
    'div',
    { class: 'tile' },
    el('p', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, String(value)),
    el('div', { class: 'tile-note' }, note),
  );
}

/** A link into the Plex app, or nothing when the server id is not known yet. */
export function plexLink(url, label = 'Open in Plex') {
  const href = safeHref(url);
  if (!href) return null;
  return el('a', { class: 'link', href, target: '_blank', rel: 'noreferrer' }, label);
}

/** Built here so the server id only has to travel once, on /api/state. */
export function plexHref(ratingKey) {
  if (!state.machineId || !ratingKey) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${state.machineId}/details?key=${key}`;
}
