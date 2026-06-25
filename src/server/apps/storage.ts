/** Server-only: per-app blob storage backed by the local filesystem. */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { appStorageDir } from '~agent/paths';

export type StorageObject = {
  key: string;
  size: number;
  contentType: string;
  updatedAt: string;
};

const META_SUFFIX = '.meta.json';

/**
 * Normalize an arbitrary client key into a safe relative path under the
 * app's storage root. Rejects absolute paths and parent traversal.
 */
function safeKey(key: string): string {
  const trimmed = key.replace(/^\/+/, '').trim();
  if (!trimmed) throw new Error('Storage key is required.');
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized.startsWith('..') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  if (normalized.endsWith(META_SUFFIX)) {
    throw new Error('Storage key may not end with .meta.json');
  }
  return normalized;
}

function resolvePaths(id: string, key: string) {
  const root = appStorageDir(id);
  const safe = safeKey(key);
  const file = path.resolve(root, safe);
  if (!file.startsWith(root + path.sep) && file !== root) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return { root, safe, file, meta: `${file}${META_SUFFIX}` };
}

export async function putObject(
  id: string,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<StorageObject> {
  const { file, meta, safe } = resolvePaths(id, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  const object: StorageObject = {
    key: safe,
    size: body.byteLength,
    contentType: contentType || 'application/octet-stream',
    updatedAt: new Date().toISOString(),
  };
  await writeFile(meta, JSON.stringify(object), 'utf8');
  return object;
}

export async function getObject(
  id: string,
  key: string,
): Promise<{ body: Uint8Array; object: StorageObject } | null> {
  const { file, meta, safe } = resolvePaths(id, key);
  try {
    const body = await readFile(file);
    let object: StorageObject;
    try {
      object = JSON.parse(await readFile(meta, 'utf8')) as StorageObject;
    } catch {
      const info = await stat(file);
      object = {
        key: safe,
        size: info.size,
        contentType: 'application/octet-stream',
        updatedAt: info.mtime.toISOString(),
      };
    }
    return { body: new Uint8Array(body), object };
  } catch {
    return null;
  }
}

export async function deleteObject(id: string, key: string): Promise<boolean> {
  const { file, meta } = resolvePaths(id, key);
  try {
    await rm(file);
    await rm(meta, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function listObjects(
  id: string,
  prefix = '',
): Promise<StorageObject[]> {
  const root = appStorageDir(id);
  const out: StorageObject[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.name.endsWith(META_SUFFIX)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (prefix && !rel.startsWith(prefix)) continue;
      const got = await getObject(id, rel);
      if (got) out.push(got.object);
    }
  }
  await walk(root);
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** Remove all stored blobs for an app (used on delete). */
export async function dropStorage(id: string): Promise<void> {
  await rm(appStorageDir(id), { recursive: true, force: true });
}
