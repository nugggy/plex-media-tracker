/**
 * Saves stored lyrics into the music library as files beside each song, named
 * like the song, then asks Plex to re-read those albums so Plexamp shows them.
 * Timed lyrics become .lrc; plain ones become .txt, the form Plex reads for
 * untimed lyrics. An existing lyric file is never replaced, and every file
 * written is recorded in lyric_files.
 */
import * as store from './db.ts';
import { getLyric, beginLyricsJob, lyricsJobMessage, endLyricsJob, recordLyricFile } from './lyrics.ts';
import { fetchTrackFiles, refreshMetadata } from './plex.ts';
import { withPlex } from './plexconnect.ts';
import { toSharePath, sidecarPath } from './lyricpaths.ts';
import { CAN_WRITE_LYRIC_FILES, fileExists, writeNewFile } from './lyricfiles.ts';
import { plainReason } from './plainerror.ts';

export interface ExportResult {
  saved: number;
  alreadyThere: number;
  inPlex: number;
  unreachable: number;
  failed: number;
  message: string;
  ok: boolean;
}

function writeReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'This PC is not allowed to write to the music folder on the NAS. Check the shared folder permissions for your Windows account.';
  }
  if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') {
    return 'This PC could not open the music folder on the NAS. Check that the NAS is on and you are on the home network.';
  }
  return plainReason(err);
}

export async function exportLyrics(keys: string[]): Promise<ExportResult> {
  const result: ExportResult = {
    saved: 0,
    alreadyThere: 0,
    inPlex: 0,
    unreachable: 0,
    failed: 0,
    message: '',
    ok: true,
  };
  beginLyricsJob('Looking up where your songs are kept');
  try {
    if (!CAN_WRITE_LYRIC_FILES) throw new Error('Saving lyrics to Plex works from the desktop app only.');

    const lyrics = keys
      .map((k) => getLyric(k))
      .filter((l) => l && !l.instrumental && (l.synced || l.plain));
    const token = store.getSetting('plex_token');
    const files = await withPlex((base) =>
      fetchTrackFiles(base, token, lyrics.map((l) => l!.rating_key)),
    );
    const plexUrl = store.getSetting('plex_url');

    let firstProblem: string | null = null;
    const albums = new Set<string>();
    for (let i = 0; i < lyrics.length; i += 1) {
      const lyric = lyrics[i]!;
      lyricsJobMessage(`Saving lyrics, ${i + 1} of ${lyrics.length}: ${lyric.title}`);
      const track = files.get(lyric.rating_key);
      if (track?.covered) {
        result.inPlex += 1;
        continue;
      }
      const song = track ? toSharePath(track.file, plexUrl) : null;
      if (!song) {
        result.unreachable += 1;
        continue;
      }
      if ((await fileExists(sidecarPath(song, 'lrc'))) || (await fileExists(sidecarPath(song, 'txt')))) {
        result.alreadyThere += 1;
        continue;
      }
      const path = sidecarPath(song, lyric.synced ? 'lrc' : 'txt');
      try {
        await writeNewFile(path, `${(lyric.synced ?? lyric.plain)!.trim()}\n`);
        recordLyricFile(lyric.rating_key, path);
        result.saved += 1;
        if (track!.albumKey) albums.add(track!.albumKey);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          result.alreadyThere += 1;
          continue;
        }
        result.failed += 1;
        firstProblem ??= writeReason(err);
        // The same cause will stop every other file, so stop at the first.
        break;
      }
    }

    let refreshProblem: string | null = null;
    let n = 0;
    for (const album of albums) {
      n += 1;
      lyricsJobMessage(`Asking Plex to re-read the albums, ${n} of ${albums.size}`);
      try {
        await withPlex((base) => refreshMetadata(base, token, album));
      } catch (err) {
        refreshProblem ??= plainReason(err);
      }
    }

    const extras = [
      result.alreadyThere ? `${result.alreadyThere} already had a lyric file` : '',
      result.inPlex ? `${result.inPlex} already had lyrics in Plex` : '',
      result.unreachable ? `${result.unreachable} could not be found on the NAS from this PC` : '',
    ].filter(Boolean);
    const skipped = extras.length ? ` Skipped: ${extras.join(', ')}.` : '';

    if (firstProblem) {
      result.ok = false;
      result.message = `${firstProblem} ${result.saved} saved before it stopped.`;
    } else if (result.saved === 0 && result.unreachable > 0) {
      result.ok = false;
      result.message =
        'Could not work out where your songs are on the NAS from this PC. Connect to your server from home and try again.' +
        skipped;
    } else if (result.saved === 0) {
      result.message = `Nothing new to save.${skipped}`;
    } else if (refreshProblem) {
      result.ok = false;
      result.message = `Saved ${result.saved} lyric files, but Plex could not be asked to re-read them. ${refreshProblem}`;
    } else {
      result.message =
        `Saved ${result.saved} lyric ${result.saved === 1 ? 'file' : 'files'}. ` +
        'Plex is re-reading those albums, so the lyrics should show in Plexamp within a few minutes.' +
        skipped;
    }
    endLyricsJob(result.message, result.ok);
    return result;
  } catch (err) {
    result.ok = false;
    result.message = plainReason(err);
    endLyricsJob(result.message, false);
    return result;
  }
}
