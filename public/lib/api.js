/**
 * Talking to the server: plain requests, a guard against answers arriving
 * out of order, and the polling loop the long builds use.
 */

export async function api(path, options) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  // The server wants a session this page does not have. signin.js listens.
  if (res.status === 401 && body.signin) {
    window.dispatchEvent(new CustomEvent('pmt:signin-needed', { detail: { setup: Boolean(body.setup) } }));
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });
/**
 * Guards against answers arriving out of order. Each call starts a new
 * request under key and hands back a check that stays true only while no
 * later request under the same key has started, so a slow answer to an old
 * question is dropped instead of drawn over a newer one.
 */
const requestSeq = {};
export function latest(key) {
  const n = (requestSeq[key] = (requestSeq[key] ?? 0) + 1);
  return () => requestSeq[key] === n;
}

/**
 * A polling loop that cannot run twice. step() does one round and resolves to
 * true while there is more to wait for; start() does nothing if the loop is
 * already going, so a button press and a tab opening cannot double it up.
 */
export function poller(step, ms) {
  let active = false;
  const tick = async () => {
    let again = false;
    try {
      again = await step();
    } catch {
      again = false;
    }
    if (again) setTimeout(tick, ms);
    else active = false;
  };
  return {
    start() {
      if (active) return;
      active = true;
      tick();
    },
    get active() {
      return active;
    },
  };
}

/**
 * Picks up a build that is already running, for when its tab is opened after
 * the button was pressed elsewhere or before a reload.
 */
export async function resumeIfRunning(progressPath, loop) {
  if (loop.active) return;
  try {
    const { running } = await api(progressPath);
    if (running) loop.start();
  } catch {
    // Nothing to resume if the progress cannot be read.
  }
}
