import { PlexError, PlexUnreachable } from './plex.ts';

/**
 * One short sentence for the banner when a sync fails. The full error still
 * goes into the scan history; this is only what the person needs to act on.
 */
export function plainReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const name = err instanceof Error ? err.name : '';

  if (err instanceof PlexUnreachable || /reach Plex at|did not answer at any/i.test(message)) {
    return 'Your Plex server did not answer. Check that it is switched on and connected.';
  }
  if (/rejected the token/i.test(message) || (err instanceof PlexError && err.status === 401)) {
    return 'Plex did not accept your token. Check the token in Settings.';
  }
  if (/TMDB rejected the API key/i.test(message)) {
    return 'TMDB did not accept your API key. Check it in Settings.';
  }
  if (/no longer on your Plex account/i.test(message)) {
    return 'Your Plex server is no longer on your account. Pick it again in Settings.';
  }
  if (/internet connection|could not reach plex\.tv|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return 'Could not get online. Check your internet connection and try again.';
  }
  if (name === 'TimeoutError' || /did not answer in time|timed out/i.test(message)) {
    return 'Something took too long to answer. Try again in a few minutes.';
  }
  if (/HTTP 5\d\d/.test(message)) {
    return 'Plex had a problem on its end. Try again shortly.';
  }
  if (/not configured|not set up/i.test(message)) {
    return 'Plex is not set up yet. Open Settings and add your server.';
  }
  const trimmed = message.replace(/\.+$/, '').trim();
  return trimmed ? `Something went wrong: ${trimmed}.` : 'Something went wrong.';
}
