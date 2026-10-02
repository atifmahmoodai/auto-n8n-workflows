import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage for photos. Keys are generated server-side ("<org>/<appointment>/<uuid>.jpg") and
 * re-validated here, so a key can never escape the storage root.
 */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  createReadStream(key: string): fs.ReadStream;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}(_thumb)?\.jpg$/;

export function createLocalStorage(root: string): Storage {
  const resolve = (key: string) => {
    if (!KEY_RE.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return path.join(root, key);
  };
  return {
    async put(key, data) {
      const file = resolve(key);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // Write to a temp file then rename, so readers never see a half-written image.
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, file);
    },
    createReadStream(key) {
      return fs.createReadStream(resolve(key));
    },
    async exists(key) {
      try {
        await fsp.access(resolve(key));
        return true;
      } catch {
        return false;
      }
    },
    async remove(key) {
      await fsp.rm(resolve(key), { force: true });
    },
  };
}
