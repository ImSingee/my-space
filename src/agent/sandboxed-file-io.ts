/** Filesystem operations executed inside one Agent session's sandbox. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  err,
  FileError,
  ok,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { agentWorkDir } from './paths';
import { prepareAgentSessionSandbox, sandboxFileSpawn } from './shell-sandbox';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_RESPONSE_BYTES = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 1024 * 1024;
const FILE_STAGED_MARKER = '{"staged":true}\n';

function pathSpellings(input: string): string[] {
  const lexical = path.resolve(input);
  const canonical = realpathSync.native(lexical);
  return [...new Set([lexical, canonical])];
}

type FileRequest =
  | { operation: 'read'; path: string }
  | {
      operation: 'write';
      path: string;
      content: string;
      waitForCommit?: boolean;
    }
  | { operation: 'append'; path: string; content: string }
  | { operation: 'info'; path: string }
  | { operation: 'list'; path: string }
  | { operation: 'canonical'; path: string }
  | { operation: 'mkdir'; path: string; recursive: boolean }
  | { operation: 'remove'; path: string; recursive: boolean; force: boolean }
  | { operation: 'temp-dir'; prefix: string }
  | { operation: 'temp-file'; prefix: string; suffix: string };

type FileResponse =
  | { ok: true; value?: unknown }
  | { ok: false; code: FileErrorCode };

// This program receives exactly one bounded JSON request on stdin and returns
// one value-free-error JSON response on stdout. On Linux, every path component
// is opened with O_NOFOLLOW and parent directories are pinned through fd paths,
// closing canonicalize-then-open symlink races. macOS does not expose openat or
// fchdir to Node; the strict Seatbelt profile applied by sandboxFileSpawn is the
// second boundary there and prevents a raced path from reaching another user
// or Agent session.
const FILE_HELPER = String.raw`
import { constants, createReadStream } from 'node:fs';
import {
  chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm,
} from 'node:fs/promises';
import path from 'node:path';

const MAX_REQUEST = ${MAX_RESPONSE_BYTES};
const MAX_FILE = ${MAX_FILE_BYTES};
const [cwd, encodedReadRoots] = process.argv.slice(1);
const readRoots = JSON.parse(
  Buffer.from(encodedReadRoots, 'base64url').toString('utf8'),
);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative));
}

function validPart(part) {
  return typeof part === 'string' && part && part !== '.' && part !== '..' &&
    !part.includes('/') && !part.includes('\\') && !part.includes('\0');
}

function addressed(input) {
  if (typeof input !== 'string' || input.includes('\0')) throw code('invalid');
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);
}

function rootFor(target, write) {
  const roots = write ? [cwd] : [cwd, ...readRoots];
  const root = roots.find((candidate) => inside(candidate, target));
  if (!root) throw code('permission_denied');
  return root;
}

function partsFor(target, write) {
  const root = rootFor(target, write);
  const relative = path.relative(root, target);
  if (!relative) return { root, parts: [] };
  const parts = relative.split(path.sep);
  if (parts.some((part) => !validPart(part))) throw code('invalid');
  return { root, parts };
}

function code(value) {
  return Object.assign(new Error(value), { fileCode: value });
}

function mapCode(error) {
  const value = error?.fileCode ?? error?.code;
  if (value === 'ABORT_ERR') return 'aborted';
  if (value === 'ENOENT') return 'not_found';
  if (value === 'EACCES' || value === 'EPERM' || value === 'ELOOP') {
    return 'permission_denied';
  }
  if (value === 'ENOTDIR') return 'not_directory';
  if (value === 'EISDIR') return 'is_directory';
  if (value === 'EINVAL' || value === 'invalid') return 'invalid';
  if (value === 'permission_denied') return value;
  if (value === 'not_supported') return value;
  return 'unknown';
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST) throw code('invalid');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY |
  constants.O_NONBLOCK | constants.O_NOFOLLOW;
const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : null;

async function enter(target, write, createParents) {
  const { root, parts } = partsFor(target, write);
  process.chdir(root);
  if (parts.length === 0) return { root, parts, leaf: '.' };
  for (const part of parts.slice(0, -1)) {
    if (createParents) {
      try { await mkdir(part, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    if (fdRoot) {
      const handle = await open(part, directoryFlags);
      if (!(await handle.stat()).isDirectory()) throw code('not_directory');
      process.chdir(fdRoot + '/' + handle.fd);
      // Intentionally retain handles until this one-shot process exits.
    } else {
      const before = await lstat(part);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        throw code('not_directory');
      }
      process.chdir(part);
      const current = await realpath('.');
      if (!inside(root, current)) throw code('permission_denied');
    }
  }
  return { root, parts, leaf: parts.at(-1) };
}

function infoValue(addressedPath, info) {
  const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' :
    info.isSymbolicLink() ? 'symlink' : null;
  if (!kind) throw code('invalid');
  return {
    name: path.basename(addressedPath),
    path: addressedPath,
    kind,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

async function boundedRead(handle) {
  const info = await handle.stat();
  if (!info.isFile()) throw code('invalid');
  if (info.size > MAX_FILE) throw code('invalid');
  const chunks = [];
  let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    size += chunk.byteLength;
    if (size > MAX_FILE) throw code('invalid');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function waitForCommit() {
  // fd 3 is created only by the trusted Runner when a caller installs the
  // before-commit hook. It gives race tests an exact point after staging and
  // before any destination path is entered, without timing a large write.
  process.stdout.write(${JSON.stringify(FILE_STAGED_MARKER)});
  const control = createReadStream(null, { fd: 3, autoClose: false });
  const chunks = [];
  let size = 0;
  for await (const chunk of control) {
    size += chunk.byteLength;
    if (size > 16) throw code('invalid');
    chunks.push(chunk);
  }
  if (Buffer.concat(chunks).toString('utf8') !== 'commit') {
    throw code('invalid');
  }
}

async function writeAtomic(target, encoded, append, commitBarrier) {
  const content = Buffer.from(encoded, 'base64');
  if (content.byteLength > MAX_FILE) throw code('invalid');
  if (append) {
    const { leaf } = await enter(target, true, true);
    if (leaf === '.') throw code('is_directory');
    const handle = await open(
      leaf,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
        constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0o600,
    );
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    return;
  }
  const temporary = path.join(
    cwd,
    '.hatch-write-' + crypto.randomUUID() + '.tmp',
  );
  let complete = false;
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0o600,
    );
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    if (commitBarrier) await waitForCommit();
    const { leaf } = await enter(target, true, true);
    if (leaf === '.') throw code('is_directory');
    try {
      const existing = await lstat(leaf);
      if (existing.isDirectory()) throw code('is_directory');
      if (existing.isFile()) await chmod(temporary, existing.mode & 0o777);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporary, leaf);
    complete = true;
  } finally {
    if (!complete) await rm(temporary, { force: true });
  }
}

async function execute(request) {
  if (request == null || typeof request !== 'object') throw code('invalid');
  const target = 'path' in request ? addressed(request.path) : null;
  switch (request.operation) {
    case 'read': {
      const { leaf } = await enter(target, false, false);
      const handle = await open(
        leaf,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        return { content: (await boundedRead(handle)).toString('base64') };
      } finally { await handle.close(); }
    }
    case 'write':
      await writeAtomic(
        target,
        request.content,
        false,
        request.waitForCommit === true,
      );
      return null;
    case 'append':
      await writeAtomic(target, request.content, true, false);
      return null;
    case 'info': {
      const { leaf } = await enter(target, false, false);
      return infoValue(target, await lstat(leaf));
    }
    case 'list': {
      const { leaf } = await enter(target, false, false);
      const handle = await open(leaf, directoryFlags);
      try {
        const directory = fdRoot ? fdRoot + '/' + handle.fd : await realpath(leaf);
        const names = await readdir(directory);
        const values = [];
        for (const name of names) {
          if (!validPart(name)) throw code('invalid');
          values.push(infoValue(path.join(target, name), await lstat(path.join(directory, name))));
        }
        return values;
      } finally { await handle.close(); }
    }
    case 'canonical': {
      rootFor(target, false);
      const value = await realpath(target);
      rootFor(value, false);
      return value;
    }
    case 'mkdir': {
      rootFor(target, true);
      if (request.recursive) {
        const { leaf } = await enter(target, true, true);
        if (leaf !== '.') await mkdir(leaf, { mode: 0o700, recursive: true });
      } else {
        const { leaf } = await enter(target, true, false);
        if (leaf === '.') throw code('invalid');
        await mkdir(leaf, { mode: 0o700 });
      }
      return null;
    }
    case 'remove': {
      const { leaf } = await enter(target, true, false);
      if (leaf === '.') throw code('permission_denied');
      await rm(leaf, { recursive: request.recursive, force: request.force });
      return null;
    }
    case 'temp-dir': {
      if (typeof request.prefix !== 'string' || request.prefix.includes('/') ||
          request.prefix.includes('\\') || request.prefix.includes('\0')) {
        throw code('invalid');
      }
      process.chdir(cwd);
      return await mkdtemp(path.join(cwd, request.prefix || 'tmp-'));
    }
    case 'temp-file': {
      for (const value of [request.prefix, request.suffix]) {
        if (typeof value !== 'string' || value.includes('/') ||
            value.includes('\\') || value.includes('\0')) throw code('invalid');
      }
      process.chdir(cwd);
      const directory = await mkdtemp(path.join(cwd, 'tmp-'));
      const targetPath = path.join(
        directory,
        request.prefix + crypto.randomUUID() + request.suffix,
      );
      const handle = await open(
        targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.close();
      return targetPath;
    }
    default: throw code('invalid');
  }
}

try {
  const value = await execute(await readRequest());
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: mapCode(error) }));
}
`;

function messageFor(code: FileErrorCode): string {
  switch (code) {
    case 'aborted':
      return 'File operation was aborted.';
    case 'not_found':
      return 'File or directory was not found.';
    case 'permission_denied':
      return 'File operation is outside the session filesystem boundary.';
    case 'not_directory':
      return 'A path component is not a directory.';
    case 'is_directory':
      return 'The addressed path is a directory.';
    case 'invalid':
      return 'Invalid file operation.';
    case 'not_supported':
      return 'File operation is not supported.';
    default:
      return 'File operation failed.';
  }
}

function runFileRequest(
  sessionId: string,
  readOnlyRoots: readonly string[],
  request: FileRequest,
  signal?: AbortSignal,
  beforeCommit?: () => void | Promise<void>,
): Promise<FileResponse> {
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, code: 'aborted' });
  }
  prepareAgentSessionSandbox(sessionId);
  const cwd = realpathSync.native(agentWorkDir(sessionId));
  const roots = readOnlyRoots.flatMap(pathSpellings);
  let wrapped: ReturnType<typeof sandboxFileSpawn>;
  try {
    wrapped = sandboxFileSpawn(
      [
        process.execPath,
        '--input-type=module',
        '--eval',
        FILE_HELPER,
        cwd,
        Buffer.from(JSON.stringify(roots)).toString('base64url'),
      ],
      sessionId,
      roots,
    );
  } catch {
    return Promise.resolve({ ok: false, code: 'not_supported' });
  }
  const waitsForCommit =
    beforeCommit !== undefined && request.operation === 'write';
  const serialized = JSON.stringify(
    waitsForCommit ? { ...request, waitForCommit: true } : request,
  );
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    return Promise.resolve({ ok: false, code: 'invalid' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let bytes = 0;
    let spawnFailed = false;
    let commitStarted = false;
    let commitFailed = false;
    const finish = (response: FileResponse) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(wrapped.command, wrapped.args, {
        cwd,
        env: {},
        signal,
        stdio: waitsForCommit
          ? ['pipe', 'pipe', 'ignore', 'pipe']
          : ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      finish({ ok: false, code: signal?.aborted ? 'aborted' : 'unknown' });
      return;
    }
    (child.stdio[3] as NodeJS.WritableStream | null)?.on('error', () => {});
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) child.kill('SIGKILL');
      else {
        stdout += chunk;
        if (
          waitsForCommit &&
          !commitStarted &&
          stdout.startsWith(FILE_STAGED_MARKER)
        ) {
          commitStarted = true;
          stdout = stdout.slice(FILE_STAGED_MARKER.length);
          void Promise.resolve()
            .then(beforeCommit)
            .then(
              () => {
                (child.stdio[3] as NodeJS.WritableStream | null)?.end('commit');
              },
              () => {
                commitFailed = true;
                child.kill('SIGKILL');
              },
            );
        }
      }
    });
    child.stdin!.on('error', () => {});
    // Wait for `close` even after AbortError/spawn errors. Resolving on the
    // earlier `error` event can return while the child still owns descriptors.
    child.on('error', () => {
      spawnFailed = true;
    });
    child.on('close', (status) => {
      if (settled) return;
      if (signal?.aborted) {
        finish({ ok: false, code: 'aborted' });
        return;
      }
      if (
        spawnFailed ||
        commitFailed ||
        status !== 0 ||
        bytes > MAX_RESPONSE_BYTES
      ) {
        finish({ ok: false, code: 'unknown' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as FileResponse;
        if (
          parsed == null ||
          typeof parsed !== 'object' ||
          typeof parsed.ok !== 'boolean'
        ) {
          throw new Error('invalid response');
        }
        finish(parsed);
      } catch {
        finish({ ok: false, code: 'unknown' });
      }
    });
    child.stdin!.end(serialized, 'utf8');
  });
}

function fileError<T>(
  result: FileResponse,
  addressedPath?: string,
): Result<T, FileError> {
  const code = result.ok ? 'unknown' : result.code;
  return err(new FileError(code, messageFor(code), addressedPath));
}

/**
 * ExecutionEnv whose shell retains NodeExecutionEnv semantics while every
 * filesystem operation crosses the same per-session OS sandbox as commands.
 */
export class SessionExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly #shell: NodeExecutionEnv;
  readonly #sessionId: string;
  readonly #readOnlyRoots: readonly string[];

  constructor(options: {
    sessionId: string;
    shellEnv: NodeJS.ProcessEnv;
    readOnlyRoots?: readonly string[];
  }) {
    this.#sessionId = options.sessionId;
    prepareAgentSessionSandbox(options.sessionId);
    this.cwd = realpathSync.native(agentWorkDir(options.sessionId));
    this.#readOnlyRoots = (options.readOnlyRoots ?? []).flatMap(pathSpellings);
    this.#shell = new NodeExecutionEnv({
      cwd: this.cwd,
      shellEnv: options.shellEnv,
    });
  }

  async absolutePath(input: string): Promise<Result<string, FileError>> {
    if (input.includes('\0')) return fileError({ ok: false, code: 'invalid' });
    return ok(
      path.isAbsolute(input)
        ? path.resolve(input)
        : path.resolve(this.cwd, input),
    );
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    if (parts.some((part) => part.includes('\0'))) {
      return fileError({ ok: false, code: 'invalid' });
    }
    return ok(path.join(...parts));
  }

  exec(command: string, options?: ShellExecOptions) {
    return this.#shell.exec(command, options);
  }

  async #request<T>(
    request: FileRequest,
    signal?: AbortSignal,
  ): Promise<Result<T, FileError>> {
    const response = await runFileRequest(
      this.#sessionId,
      this.#readOnlyRoots,
      request,
      signal,
    );
    if (!response.ok) {
      return fileError<T>(
        response,
        'path' in request ? request.path : undefined,
      );
    }
    return ok<T, FileError>(response.value as T);
  }

  async readBinaryFile(
    input: string,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileError>> {
    const result = await this.#request<{ content: string }>(
      { operation: 'read', path: input },
      signal,
    );
    return result.ok
      ? ok<Uint8Array, FileError>(Buffer.from(result.value.content, 'base64'))
      : err<Uint8Array, FileError>(result.error);
  }

  async readTextFile(
    input: string,
    signal?: AbortSignal,
  ): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(input, signal);
    if (!result.ok) return err<string, FileError>(result.error);
    const content = Buffer.from(result.value).toString('utf8');
    return Buffer.from(content, 'utf8').equals(Buffer.from(result.value))
      ? ok<string, FileError>(content)
      : err<string, FileError>(
          new FileError('invalid', 'File is not valid UTF-8.', input),
        );
  }

  async readTextLines(
    input: string,
    options?: { maxLines?: number; abortSignal?: AbortSignal },
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) {
      return ok<string[], FileError>([]);
    }
    const result = await this.readTextFile(input, options?.abortSignal);
    if (!result.ok) return err<string[], FileError>(result.error);
    const lines = result.value ? result.value.split(/\r\n|[\r\n]/) : [];
    if (lines.at(-1) === '') lines.pop();
    return ok<string[], FileError>(
      options?.maxLines === undefined
        ? lines
        : lines.slice(0, options.maxLines),
    );
  }

  writeFile(input: string, content: string | Uint8Array, signal?: AbortSignal) {
    return this.#request<void>(
      {
        operation: 'write',
        path: input,
        content: Buffer.from(content).toString('base64'),
      },
      signal,
    );
  }

  appendFile(
    input: string,
    content: string | Uint8Array,
    signal?: AbortSignal,
  ) {
    return this.#request<void>(
      {
        operation: 'append',
        path: input,
        content: Buffer.from(content).toString('base64'),
      },
      signal,
    );
  }

  fileInfo(input: string, signal?: AbortSignal) {
    return this.#request<FileInfo>({ operation: 'info', path: input }, signal);
  }

  listDir(input: string, signal?: AbortSignal) {
    return this.#request<FileInfo[]>(
      { operation: 'list', path: input },
      signal,
    );
  }

  canonicalPath(input: string, signal?: AbortSignal) {
    return this.#request<string>(
      { operation: 'canonical', path: input },
      signal,
    );
  }

  async exists(
    input: string,
    signal?: AbortSignal,
  ): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(input, signal);
    if (result.ok) return ok<boolean, FileError>(true);
    return result.error.code === 'not_found'
      ? ok<boolean, FileError>(false)
      : err<boolean, FileError>(result.error);
  }

  createDir(
    input: string,
    options?: { recursive?: boolean; abortSignal?: AbortSignal },
  ) {
    return this.#request<void>(
      {
        operation: 'mkdir',
        path: input,
        recursive: options?.recursive ?? true,
      },
      options?.abortSignal,
    );
  }

  remove(
    input: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
      abortSignal?: AbortSignal;
    },
  ) {
    return this.#request<void>(
      {
        operation: 'remove',
        path: input,
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      },
      options?.abortSignal,
    );
  }

  createTempDir(prefix = 'tmp-', signal?: AbortSignal) {
    return this.#request<string>({ operation: 'temp-dir', prefix }, signal);
  }

  createTempFile(options?: {
    prefix?: string;
    suffix?: string;
    abortSignal?: AbortSignal;
  }) {
    return this.#request<string>(
      {
        operation: 'temp-file',
        prefix: options?.prefix ?? '',
        suffix: options?.suffix ?? '',
      },
      options?.abortSignal,
    );
  }

  async cleanup(): Promise<void> {
    await this.#shell.cleanup();
  }
}

export async function writeAgentWorkspaceFile(
  sessionId: string,
  input: string,
  content: string | Uint8Array,
  signal?: AbortSignal,
  beforeCommit?: () => void | Promise<void>,
): Promise<void> {
  const response = await runFileRequest(
    sessionId,
    [],
    {
      operation: 'write',
      path: input,
      content: Buffer.from(content).toString('base64'),
    },
    signal,
    beforeCommit,
  );
  if (!response.ok) throw new Error(messageFor(response.code));
}
