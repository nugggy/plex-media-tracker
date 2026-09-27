import { isConfigured, getSetting } from './db.ts';
import { runRefresh } from './scanner.ts';

/**
 * Catches up on the watchlist, episodes and library on every start, so the
 * dashboard is current the moment it opens. The slow MusicBrainz scan is
 * deliberately left for the Scan button. Shared by the PC server and the phone.
 */
export function startBackgroundSync(): boolean {
  if (!isConfigured() || getSetting('sync_on_start') !== '1') return false;
  void runRefresh();
  return true;
}
