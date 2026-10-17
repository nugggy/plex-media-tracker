/**
 * Signing in to the server on the NAS, and on the phone, choosing which
 * server that is. A PC running the app for itself needs none of this: its
 * server says so, and the page starts straight away.
 *
 * Signing in opens Plex's own sign-in page (in a small window on a computer,
 * in the phone's browser on the phone) and waits for the server to say the
 * owner approved it. The browser's session is then a cookie the page cannot
 * see; the phone's is a token the phone keeps and sends with each call.
 */

import { $ } from './dom.js';
import { post } from './api.js';

/** The phone's link to the NAS, set up by mobile/entry.ts. Absent in a browser. */
const phone = () => window.pmtClient ?? null;

const POLL_MS = 2_000;
const GIVE_UP_MS = 15 * 60_000;

export async function authStatus() {
  try {
    const r = await fetch('/api/auth/status');
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 && body.setup) return { needsServer: true };
    if (!r.ok) return { error: body.error || `HTTP ${r.status}`, offline: Boolean(body.offline) };
    return body;
  } catch (err) {
    return { error: err.message };
  }
}

function say(text, bad = false) {
  const node = $('#signin-status');
  node.textContent = text;
  node.classList.toggle('bad', bad);
}

let pollTimer = null;

function showSignIn({ needServer = false, message = '' } = {}) {
  const client = phone();
  const server = client?.serverUrl() ?? '';
  $('#signin-server-field').hidden = !(client && (needServer || !server));
  $('#signin-home-field').hidden = $('#signin-server-field').hidden;
  $('#signin-server').value = server;
  $('#signin-home').value = client?.lanUrl() ?? '';
  $('#signin-text').textContent =
    message ||
    (client && !server
      ? 'Enter the address of Plex Media Tracker on your NAS, then sign in with the Plex account that owns your server.'
      : 'Sign in with the Plex account that owns your Plex server.');
  say('');
  $('#signin-btn').disabled = false;
  $('#signin').hidden = false;
  document.body.classList.add('signing-in');
  ($('#signin-server-field').hidden ? $('#signin-btn') : $('#signin-server')).focus();
}

async function signIn() {
  const client = phone();
  const button = $('#signin-btn');
  if (pollTimer) clearTimeout(pollTimer);

  // A browser only lets a click open a window, so it is opened now and pointed
  // at Plex once the server has asked for a PIN.
  const popup = client ? null : window.open('', 'plex-signin', 'width=520,height=760');

  if (client && !$('#signin-server-field').hidden) {
    try {
      client.setServer($('#signin-server').value);
      const home = $('#signin-home').value.trim();
      if (home) client.setLanUrl(home);
    } catch (err) {
      say(err.message, true);
      return;
    }
    say(`Checking ${client.serverUrl()}`);
    const status = await authStatus();
    if (status.error) {
      say(`Could not reach your server. Check the addresses and that the NAS is on. (${status.error})`, true);
      return;
    }
    if (status.lan_url) client.setLanUrl(status.lan_url);
    if (status.signed_in) {
      location.reload();
      return;
    }
  }

  button.disabled = true;
  let start;
  try {
    start = await post('/api/auth/start', { device: client ? 'phone' : 'browser' });
  } catch (err) {
    popup?.close();
    button.disabled = false;
    say(err.message, true);
    return;
  }

  try {
    if (client) await client.openSignIn(start.auth_url);
    else if (popup) popup.location.href = start.auth_url;
    else {
      // The window was blocked, so Plex opens in this tab and comes back here.
      window.location.href = start.auth_url;
      return;
    }
  } catch (err) {
    button.disabled = false;
    say(err.message, true);
    return;
  }
  say(
    client
      ? 'Approve the sign-in in your browser, then come back to this app.'
      : 'Approve the sign-in in the Plex window.',
  );

  const startedAt = Date.now();
  const check = async () => {
    let r;
    try {
      r = await post('/api/auth/check', { ticket: start.ticket });
    } catch {
      r = { status: 'waiting' };
    }
    if (r.status === 'done') {
      if (client) client.setToken(r.token);
      popup?.close();
      say(`Signed in as ${r.account}.`);
      location.reload();
      return;
    }
    if (r.status === 'refused') {
      popup?.close();
      button.disabled = false;
      say(r.message, true);
      return;
    }
    if (r.status === 'expired' || Date.now() - startedAt > GIVE_UP_MS) {
      button.disabled = false;
      say('The sign-in timed out. Press the button to try again.', true);
      return;
    }
    pollTimer = setTimeout(check, POLL_MS);
  };
  pollTimer = setTimeout(check, POLL_MS);
}

export function wireSignIn() {
  $('#signin-btn').addEventListener('click', signIn);
  $('#signin-server').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signIn();
  });
  // Any call the server turns away for want of a session brings this back up,
  // as when a session has been signed out from another device.
  window.addEventListener('pmt:signin-needed', (e) => {
    if ($('#signin').hidden) showSignIn({ needServer: Boolean(e.detail?.setup) });
  });
}

/**
 * True when the page may go on and load its data: signed in, no sign-in
 * needed, or the server cannot be reached and the phone's saved copy will do.
 * Otherwise the sign-in screen is shown, and a successful sign-in reloads.
 */
export async function whenSignedIn() {
  const client = phone();
  if (client && !client.serverUrl()) {
    showSignIn({ needServer: true });
    return false;
  }
  const status = await authStatus();
  if (status.needsServer) {
    showSignIn({ needServer: true });
    return false;
  }
  if (status.error) return true; // Offline or broken: let the page show what it has.
  // Only learnt once signed in; a home address typed in at setup is kept.
  if (client && status.lan_url) client.setLanUrl(status.lan_url);
  if (status.signed_in) return true;
  showSignIn();
  return false;
}

/** Sign out here, or everywhere. Either way the page starts again at the sign-in screen. */
export async function signOut(everywhere = false) {
  try {
    await post(everywhere ? '/api/auth/signout-all' : '/api/auth/signout');
  } finally {
    phone()?.setToken(null);
    location.reload();
  }
}
