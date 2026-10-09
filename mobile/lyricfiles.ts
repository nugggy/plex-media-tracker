/**
 * The phone's stand-in for src/lyricfiles.ts. A phone cannot reach the NAS's
 * shared folders, so saving lyric files is a desktop job.
 */
export const CAN_WRITE_LYRIC_FILES = false;

export async function fileExists(_path: string): Promise<boolean> {
  return false;
}

export async function writeNewFile(_path: string, _text: string): Promise<void> {
  throw new Error('Saving lyrics to Plex works from the desktop app only.');
}
