/**
 * Pieces more than one view draws: artwork, the YouTube player, the press
 * twice button, filter chips, the Add to watchlist button, stat tiles and
 * links into Plex.
 */

import { $$, banner, el, safeHref } from './lib/dom.js';
import { api, post } from './lib/api.js';
import { state } from './lib/state.js';
import { refreshState } from './views/status.js';
import { jumpLetters } from './feed.js';

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
            linkButton(r.search_url, 'Wrong one?', 'Search YouTube yourself'),
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
        linkButton(r.search_url, 'Search YouTube'),
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
  const letter = () => el('div', { class: `${cls} art-fallback`, 'aria-hidden': 'true' }, (name || '?').charAt(0).toUpperCase());
  // With no picture at all there is nothing to wait for. An img with no src
  // never fires error, so it would sit there as an empty box.
  if (!src) return letter();
  const fallback = () => img.replaceWith(letter());
  // The phone app cannot load /thumb as a plain image address, so it supplies
  // a loader that fetches the picture and hands back a local address.
  const loader = window.pmtThumbLoader;
  const img = el('img', { class: cls, src: loader ? null : src, alt: '', loading: 'lazy' });
  img.addEventListener('error', fallback);
  if (loader) {
    // Fetched only once on screen, the way loading="lazy" works for a plain image.
    artworkObserver().observe(img);
    img.dataset.src = src;
  }
  return img;
}

/* ----------------------------------------------------------------- badges */

/**
 * Sets a count on every badge of that name. The top tabs and the phone's
 * bottom bar each carry one, so both are kept in step. The label says what the
 * number counts: it is the badge's tooltip, and it is added to the tab's name
 * for screen readers, since a bare number read after "Coming soon" says
 * nothing about which number it is.
 */
export function setBadge(name, n, label, hideZero = false) {
  for (const pill of document.querySelectorAll(`[data-count="${name}"]`)) {
    pill.textContent = String(n);
    pill.title = label;
    pill.hidden = hideZero && !n;
    const tab = pill.closest('[role="tab"]');
    if (tab?.dataset.label) {
      tab.setAttribute('aria-label', pill.hidden ? tab.dataset.label : `${tab.dataset.label}, ${label}`);
    }
  }
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

/**
 * A link that sits among a row's buttons, drawn as a quiet button so it reads
 * as something to press rather than stray orange text. It stays an <a>, so it
 * opens in a new tab and can be copied like any link. Nothing is drawn for an
 * address safeHref will not pass.
 */
export function linkButton(url, label, title = null) {
  const href = safeHref(url);
  if (!href) return null;
  return el(
    'a',
    { class: 'btn btn-tiny btn-ghost btn-out', href, target: '_blank', rel: 'noreferrer', title },
    label,
  );
}

/** A link into the Plex app, or nothing when the server id is not known yet. */
export function plexLink(url, label = 'Open in Plex') {
  return linkButton(url, label);
}

/* ------------------------------------------------------------ poster grid */

/**
 * The trailer player for a card in a poster grid. A card there is too narrow
 * to hold a video, so the player goes in a slot straight after the card that
 * spans the whole row of the grid.
 */
export function gridPlayer(item, card) {
  let slot = card.nextElementSibling;
  if (!slot?.classList.contains('grid-slot')) {
    slot = el('div', { class: 'grid-slot' });
    card.after(slot);
  }
  return togglePlayer(item, slot);
}

/* -------------------------------------------------------------- long lists */

/**
 * Draws a long, sorted list a page at a time, with an optional A to Z bar
 * above it that offers only the letters present.
 *
 * rows are already sorted; keyOf gives the key they were sorted by, so a
 * letter in the bar leads to where that letter really starts. limits[name] is
 * how many rows are drawn, and redraw is the view's own render function, which
 * is called again when Show more or a letter beyond the drawn rows is pressed.
 */
export function drawLongList({ list, rows, draw, name, redraw, keyOf = null, page = 100, noun = 'item' }) {
  const limits = state.limits;
  const limit = Math.max(page, limits[name] ?? page);
  const jumpId = `${list.id}-jump`;
  document.getElementById(jumpId)?.remove();

  const letters = keyOf ? jumpLetters(rows.map(keyOf)) : [];
  const firstOf = new Map(letters.map((l) => [l.index, l.letter]));
  if (letters.length > 1) {
    list.before(
      el(
        'nav',
        { class: 'jumpbar', id: jumpId, 'aria-label': 'Jump to a letter' },
        letters.map(({ letter, index }) =>
          el(
            'button',
            {
              type: 'button',
              class: 'jump',
              'aria-label': letter === '#' ? 'Jump to numbers and symbols' : `Jump to ${letter}`,
              onclick: () => {
                if (index >= limits[name]) {
                  limits[name] = Math.ceil((index + 1) / page) * page;
                  redraw();
                }
                const target = list.querySelector(`[data-letter="${CSS.escape(letter)}"]`);
                if (!target) return;
                target.scrollIntoView({ block: 'start' });
                target.focus({ preventScroll: true });
              },
            },
            letter,
          ),
        ),
      ),
    );
  }

  rows.slice(0, limit).forEach((row, i) => {
    const node = draw(row);
    if (firstOf.has(i)) {
      node.dataset.letter = firstOf.get(i);
      // Focusable from script only, so a jump lands the keyboard on the row.
      node.tabIndex = -1;
    }
    list.append(node);
  });

  if (rows.length > limit) {
    list.append(
      el(
        'div',
        { class: 'filter-summary show-more' },
        el('span', {}, `Showing ${limit} of ${rows.length} ${noun}s.`),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-tiny',
            onclick: () => {
              limits[name] = limit + page;
              redraw();
              // Keep the keyboard where the new rows start, not back at the top.
              list.children[limit]?.querySelector('button, a')?.focus();
            },
          },
          'Show more',
        ),
      ),
    );
  }
}

/** Built here so the server id only has to travel once, on /api/state. */
export function plexHref(ratingKey) {
  if (!state.machineId || !ratingKey) return null;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  return `https://app.plex.tv/desktop/#!/server/${state.machineId}/details?key=${key}`;
}
