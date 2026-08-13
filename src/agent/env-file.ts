/** Secure, atomic storage for the current Agent session's private `.env`. */
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { requireEnvKey } from './env-keys';
import { setAgentOwned } from './shell-sandbox';

export type EnvFileEntry = {
  key: string;
  value: string;
  /** Classification is enforced by the request bridge, not the file codec. */
  secret?: boolean;
};

export const ENV_FILE_NAME = '.env';
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const locks = new Map<string, Promise<unknown>>();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const TEMP_FILE_RE = /^\.env\.[0-9a-f-]{36}\.tmp$/i;

function isWellFormed(value: string): boolean {
  return (
    value as string & {
      isWellFormed(): boolean;
    }
  ).isWellFormed();
}

function envPath(workDir: string): string {
  return path.join(workDir, ENV_FILE_NAME);
}

function isSafeUnquotedValue(value: string): boolean {
  const first = value[0];
  return (
    value.length > 0 &&
    !/[\s#]/u.test(value) &&
    (!["'", '"', '`'].includes(first) || value.at(-1) !== first)
  );
}

function canonicalValueEncoding(value: string): string | undefined {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  // dotenv expands literal backslash-n/backslash-r sequences only inside
  // double quotes. Use that delimiter solely when it is lossless.
  if (
    !value.includes('"') &&
    !value.includes('\\n') &&
    !value.includes('\\r')
  ) {
    return `"${value}"`;
  }
  if (isSafeUnquotedValue(value)) return value;
  return undefined;
}

function encodeValue(key: string, value: string): string {
  const encoded = canonicalValueEncoding(value);
  if (encoded === undefined) {
    throw new Error(
      `Environment value for "${key}" cannot be represented safely in canonical dotenv.`,
    );
  }
  return encoded;
}

function decodeValue(key: string, encoded: string): string {
  const delimiter = encoded[0];
  if (
    encoded.length >= 2 &&
    ["'", '"', '`'].includes(delimiter) &&
    encoded.at(-1) === delimiter
  ) {
    const inner = encoded.slice(1, -1);
    if (inner.includes(delimiter)) {
      throw new Error('The .env file has an invalid value encoding.');
    }
    requireEnvValue(key, inner);
    if (canonicalValueEncoding(inner) !== encoded) {
      throw new Error('The .env file has a non-canonical value encoding.');
    }
    return inner;
  }

  requireEnvValue(key, encoded);
  if (!isSafeUnquotedValue(encoded)) {
    throw new Error('The .env file has an invalid value encoding.');
  }
  if (canonicalValueEncoding(encoded) !== encoded) {
    throw new Error('The .env file has a non-canonical value encoding.');
  }
  return encoded;
}

function requireEnvValue(key: string, value: string): string {
  if (
    !isWellFormed(value) ||
    encoder.encode(value).byteLength > MAX_ENV_VALUE_BYTES ||
    value.includes('\r') ||
    value.includes('\n') ||
    value.includes('\0')
  ) {
    // Include the model-visible key for diagnosis, but never the value.
    throw new Error(`Environment value for "${key}" is invalid.`);
  }
  return value;
}

export function parseEnvFile(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = contents.endsWith('\n')
    ? contents.slice(0, -1).split('\n')
    : contents.split('\n');
  if (lines.length === 1 && lines[0] === '') return result;

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error('The .env file has an invalid entry.');
    }
    const key = line.slice(0, separator);
    requireEnvKey(key);
    if (result.has(key)) {
      throw new Error(`The .env file contains duplicate key "${key}".`);
    }
    result.set(key, decodeValue(key, line.slice(separator + 1)));
  }
  return result;
}

export function serializeEnvFile(values: ReadonlyMap<string, string>): string {
  return [...values]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => {
      requireEnvKey(key);
      return `${key}=${encodeValue(key, requireEnvValue(key, value))}`;
    })
    .join('\n')
    .concat(values.size > 0 ? '\n' : '');
}

async function assertRegularTarget(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('The .env path must be a regular file.');
    }
    if (info.size > MAX_ENV_FILE_BYTES) {
      throw new Error('The .env file is too large.');
    }
    if ((info.mode & 0o777) !== 0o600) {
      throw new Error('The .env file must have mode 0600.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function openStableWorkDir(workDir: string): Promise<FileHandle> {
  const absolute = path.resolve(workDir);
  // The trusted anchor is the parent of the session directory. Resolve that
  // once, then require the `session/work` suffix itself to contain no symlink.
  // This tolerates host aliases such as macOS /var -> /private/var without
  // accepting an Agent-controlled session/root redirect.
  const anchor = path.dirname(path.dirname(absolute));
  const [canonicalAnchor, canonicalWork] = await Promise.all([
    realpath(anchor),
    realpath(absolute),
  ]);
  const expected = path.resolve(
    canonicalAnchor,
    path.relative(anchor, absolute),
  );
  if (canonicalWork !== expected) {
    throw new Error('The Agent work directory must not contain symlinks.');
  }
  const before = await lstat(absolute);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('The Agent work directory must be a real directory.');
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      constants.O_NONBLOCK |
      NOFOLLOW,
  );
  const opened = await handle.stat();
  if (
    !opened.isDirectory() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino
  ) {
    await handle.close();
    throw new Error('The Agent work directory changed unexpectedly.');
  }
  return handle;
}

async function readBounded(handle: FileHandle): Promise<string> {
  const buffer = Buffer.allocUnsafe(MAX_ENV_FILE_BYTES + 1);
  let total = 0;
  while (total < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.byteLength - total,
      null,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > MAX_ENV_FILE_BYTES) {
    throw new Error('The .env file is too large.');
  }
  try {
    return decoder.decode(buffer.subarray(0, total));
  } catch {
    throw new Error('The .env file must contain valid UTF-8.');
  }
}

async function readExistingFile(
  filePath: string,
): Promise<Map<string, string>> {
  if (!(await assertRegularTarget(filePath))) return new Map();
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW,
    );
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > MAX_ENV_FILE_BYTES ||
      (info.mode & 0o777) !== 0o600
    ) {
      throw new Error('The .env path must be a small regular file.');
    }
    return parseEnvFile(await readBounded(handle));
  } finally {
    await handle?.close();
  }
}

async function removeStaleTemporaryFiles(workDir: string): Promise<void> {
  for (const entry of await readdir(workDir, { withFileTypes: true })) {
    if (!TEMP_FILE_RE.test(entry.name) || entry.isDirectory()) continue;
    await unlink(path.join(workDir, entry.name)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function serialized<T>(
  filePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const prior = locks.get(filePath) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(task);
  locks.set(filePath, next);
  try {
    return await next;
  } finally {
    if (locks.get(filePath) === next) locks.delete(filePath);
  }
}

function validateEntries(entries: readonly EnvFileEntry[]): void {
  if (entries.length < 1 || entries.length > 10) {
    throw new Error(
      'An environment update must contain between 1 and 10 entries.',
    );
  }
  const keys = new Set<string>();
  for (const entry of entries) {
    requireEnvKey(entry.key);
    if (keys.has(entry.key)) {
      throw new Error('Environment keys must be unique.');
    }
    keys.add(entry.key);
    requireEnvValue(entry.key, entry.value);
  }
}

export async function readEnvFile(
  workDir: string,
): Promise<Map<string, string>> {
  const filePath = envPath(workDir);
  return serialized(filePath, async () => {
    const directory = await openStableWorkDir(workDir);
    try {
      return await readExistingFile(filePath);
    } finally {
      await directory.close();
    }
  });
}

/** Merge an all-or-nothing update and atomically replace `.env`. */
export async function writeEnvFile(
  workDir: string,
  entries: readonly EnvFileEntry[],
): Promise<void> {
  validateEntries(entries);
  const filePath = envPath(workDir);
  await serialized(filePath, async () => {
    const directory = await openStableWorkDir(workDir);
    try {
      await removeStaleTemporaryFiles(workDir);
      const values = await readExistingFile(filePath);
      for (const entry of entries) values.set(entry.key, entry.value);
      const output = serializeEnvFile(values);
      if (Buffer.byteLength(output, 'utf8') > MAX_ENV_FILE_BYTES) {
        throw new Error('The .env file would exceed its size limit.');
      }

      const temporary = path.join(
        workDir,
        `${ENV_FILE_NAME}.${crypto.randomUUID()}.tmp`,
      );
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NONBLOCK |
            NOFOLLOW,
          0o600,
        );
        await handle.writeFile(output, 'utf8');
        await handle.chmod(0o600);
        await handle.sync();
        const written = await handle.stat();
        setAgentOwned([temporary]);
        // Persist the ownership metadata before publishing the inode.
        await handle.sync();
        await handle.close();
        handle = undefined;
        const owned = await lstat(temporary);
        if (
          !owned.isFile() ||
          owned.isSymbolicLink() ||
          owned.dev !== written.dev ||
          owned.ino !== written.ino ||
          (owned.mode & 0o777) !== 0o600
        ) {
          throw new Error(
            'The temporary environment file changed unexpectedly.',
          );
        }
        await rename(temporary, filePath);
        await directory.sync();
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    } finally {
      await directory.close();
    }
  });
}
