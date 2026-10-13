/**
 * Small DOM helpers shared by every view: element building, the banner,
 * and the checks a link or a burst of typing has to pass.
 */

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];
/**
 * Attributes whose value is the words "true" or "false" rather than being
 * present or absent. aria-pressed="" means nothing to a screen reader, so a
 * boolean given to one of these is written out as text.
 */
const STRING_BOOLEAN = /^(aria-|data-)|^(spellcheck|draggable|contenteditable)$/;

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean' && STRING_BOOLEAN.test(key)) {
      node.setAttribute(key, String(value));
      continue;
    }
    if (value === false) continue;
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

export function banner(message, kind) {
  const node = $('#banner');
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  // ok is green, info is a neutral note for work still going, anything else is red.
  node.className = kind === 'ok' ? 'banner ok' : kind === 'info' ? 'banner info' : 'banner';
  // An error is announced straight away; anything else waits for a pause.
  const error = kind !== 'ok' && kind !== 'info';
  node.setAttribute('role', error ? 'alert' : 'status');
  node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  node.hidden = false;
}

/**
 * A link address the page is willing to open, or null. Only https is let
 * through: every link the server sends is https, and anything else (a
 * javascript: address in a chart feed, say) is dropped rather than rendered.
 */
export function safeHref(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Calls fn once typing has paused for ms. */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
