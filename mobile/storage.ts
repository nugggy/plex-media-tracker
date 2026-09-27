/**
 * Saving the database file so a kill at any moment leaves a loadable copy:
 * write the new copy beside the old, remove the old, rename the new. On load,
 * the main file wins; the side copy is used only when the main one is missing
 * or unreadable and the side copy is a valid database.
 */
export interface FileApi {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const MAIN = 'tracker.db';
const SIDE = 'tracker.db.tmp';

export async function saveDatabase(fs: FileApi, bytes: Uint8Array): Promise<void> {
  await fs.write(SIDE, bytes);
  if (await fs.read(MAIN)) await fs.remove(MAIN);
  await fs.rename(SIDE, MAIN);
}

export async function loadDatabase(
  fs: FileApi,
  isValid: (b: Uint8Array) => boolean,
): Promise<Uint8Array | null> {
  const main = await fs.read(MAIN);
  if (main && isValid(main)) return main;
  const side = await fs.read(SIDE);
  if (side && isValid(side)) return side;
  return null;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
