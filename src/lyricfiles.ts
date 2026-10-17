/**
 * Reading and writing lyric files on the NAS. The only module that touches
 * the music library's folders.
 */
import { access, writeFile } from 'node:fs/promises';

export const CAN_WRITE_LYRIC_FILES = true;

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates the file, and fails rather than replace one that appeared meanwhile. */
export async function writeNewFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' });
}
