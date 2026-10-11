/** Standalone source workspaces. Locks survive crashes; no authored work is reset. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { CliError } from './error';
import type { Profile } from './config';
import { platformClient } from './client';

export type Kind = 'app' | 'workflow';
export type Workspace = {
  version: 1;
  kind: Kind;
  url: string;
  id: string;
  generation: string;
  masterCommit: string | null;
  pending?: { command: string; commit: string; startedAt: string };
  lastDeployment?: { version: number; deploymentId: string };
};
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}
export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  allowFailure = false,
): Promise<{ code: number; stdout: string }> {
  if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: childEnvironment(),
      signal,
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 300 * 1024 * 1024) child.kill();
    });
    child.stderr.resume();
    child.once('error', () =>
      reject(
        new CliError(
          signal.aborted ? 'cancelled' : 'tool_unavailable',
          signal.aborted
            ? 'Cancelled.'
            : `Could not run ${executable}. Install the required tool and retry.`,
          signal.aborted ? 130 : 7,
        ),
      ),
    );
    child.once('close', (code) => {
      if (signal.aborted)
        reject(
          new CliError('cancelled', 'Cancelled; workspace retained.', 130),
        );
      else if ((code ?? 1) !== 0 && !allowFailure)
        reject(
          new CliError(
            'local_command_failed',
            `${executable} failed. Source was retained; inspect the workspace before retrying.`,
            6,
          ),
        );
      else resolveResult({ code: code ?? 1, stdout: stdout.trim() });
    });
  });
}
export const git = async (
  root: string,
  signal: AbortSignal,
  args: string[],
  allowFailure = false,
) =>
  command(
    'git',
    [
      '-c',
      'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      ...args,
    ],
    root,
    signal,
    allowFailure,
  );

export async function canonicalTarget(target: string) {
  const absolute = resolve(target);
  const existing = await lstat(absolute).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (existing?.isSymbolicLink())
    throw new CliError(
      'invalid_workspace',
      'Workspace root must not be a symlink.',
      6,
    );
  if (existing) return realpath(absolute);
  const parent = await realpath(dirname(absolute)).catch(() => {
    throw new CliError(
      'directory_parent_missing',
      'Create the destination parent directory first.',
    );
  });
  return join(parent, basename(absolute));
}
export async function withWorkspaceLock<T>(
  target: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await canonicalTarget(target);
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 20);
  const lock = join(dirname(root), `.hatch-cli-${hash}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new CliError(
      'workspace_locked',
      'Workspace is locked by another process. After a crash, inspect the lock owner and remove the stale lock only when no writer remains.',
      6,
    );
  }
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({
        pid: process.pid,
        root,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return await action(root);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
export async function assertAbsent(root: string) {
  const entry = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entry)
    throw new CliError(
      'directory_exists',
      'Destination already exists; choose another directory. Existing files were preserved.',
      6,
    );
}
export async function workspace(
  root: string,
  kind: Kind,
  credential: Profile,
): Promise<Workspace> {
  for (const path of [root, join(root, '.git')]) {
    const entry = await lstat(path).catch(() => null);
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      throw new CliError(
        'invalid_workspace',
        'Use a standalone CLI checkout with a real .git directory.',
      );
  }
  const file = await open(join(root, '.git', 'hatch-cli.json'), 'r').catch(
    () => {
      throw new CliError(
        'invalid_workspace',
        'Missing CLI workspace metadata. Clone/create with hatch first.',
      );
    },
  );
  let value: Workspace;
  try {
    value = JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
  if (
    value.version !== 1 ||
    value.kind !== kind ||
    value.url !== credential.url ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.generation !== 'string' ||
    !value.generation
  )
    throw new CliError(
      'workspace_instance_mismatch',
      'Workspace belongs to a different instance/resource kind or has invalid metadata.',
      6,
    );
  return value;
}
export async function saveWorkspace(root: string, value: Workspace) {
  const destination = join(root, '.git', 'hatch-cli.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
}
export async function clean(root: string, signal: AbortSignal) {
  if (
    (
      await git(root, signal, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ])
    ).stdout
  )
    throw new CliError(
      'dirty_workspace',
      'Commit or save local changes before update/deploy. No files were discarded.',
      6,
    );
}
export async function safeTree(
  root: string,
  signal: AbortSignal,
  ref = 'HEAD',
) {
  const entries = (
    await git(root, signal, ['ls-tree', '-r', '-z', ref])
  ).stdout.split('\0');
  for (const entry of entries) {
    const separator = entry.indexOf('\t');
    const info = entry.slice(0, separator);
    const name = entry.slice(separator + 1);
    if (!name) continue;
    if (
      info.startsWith('120000') ||
      info.startsWith('160000') ||
      name
        .split('/')
        .some((part) =>
          ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()),
        )
    )
      throw new CliError(
        'unsafe_source',
        'Source contains symlinks, submodules or tracked platform-managed paths. Remove them before using this workspace.',
        6,
      );
  }
}
export async function writeFiles(
  root: string,
  files: { path: string; contentBase64: string }[],
) {
  const seen = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (
      !file.path ||
      parts.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()) ||
          /[\\:]/.test(part) ||
          [...part].some((character) => character.charCodeAt(0) < 32),
      ) ||
      seen.has(file.path)
    )
      throw new CliError(
        'unsafe_payload',
        'Platform returned an unsafe file path.',
        7,
      );
    seen.add(file.path);
    const target = join(root, ...parts);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'), {
      flag: 'wx',
      mode: 0o644,
    });
  }
}
export async function installSdk(
  root: string,
  kind: Kind,
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
) {
  const payload = await platformClient(credential, timeout, signal).sdk.get({
    kind,
  });
  const stage = await mkdtemp(join(root, '.hatch-stage-'));
  const destination = join(root, '.hatch');
  const backup = join(root, `.hatch-backup-${randomUUID()}`);
  let moved = false;
  try {
    await writeFiles(stage, payload.files);
    const existing = await lstat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      },
    );
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new CliError(
          'unsafe_sdk',
          '.hatch must be a real generated directory.',
          6,
        );
      await rename(destination, backup);
      moved = true;
    }
    try {
      await rename(stage, destination);
    } catch (error) {
      if (moved) await rename(backup, destination);
      throw error;
    }
    if (moved) await rm(backup, { recursive: true, force: true });
    const exclude = join(root, '.git', 'info', 'exclude');
    await mkdir(dirname(exclude), { recursive: true });
    await writeFile(
      exclude,
      '\n.hatch/\n.hatch-stage-*/\n.hatch-backup-*/\nnode_modules/\ngen/\n',
      { flag: 'a' },
    );
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    await command(
      pnpm,
      ['install', '--ignore-scripts', '--lockfile=false'],
      root,
      signal,
    );
    if (
      kind === 'app' &&
      payload.tooling &&
      (await access(join(root, 'buf.yaml')).then(
        () => true,
        () => false,
      ))
    ) {
      const gen = await lstat(join(root, 'gen')).catch(() => null);
      if (gen?.isSymbolicLink())
        throw new CliError('unsafe_codegen', 'gen must not be a symlink.', 6);
      await command(
        pnpm,
        [
          'dlx',
          '--allow-build',
          '@bufbuild/buf',
          '--package',
          `@bufbuild/buf@${payload.tooling.bufVersion}`,
          '--package',
          `@bufbuild/protoc-gen-es@${payload.tooling.protocGenEsVersion}`,
          'buf',
          'generate',
          '--template',
          '.hatch/buf.gen.yaml',
        ],
        root,
        signal,
      );
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function sourceBundle(root: string, signal: AbortSignal) {
  const file = join(root, '.git', `hatch-deploy-${randomUUID()}.bundle`);
  try {
    await git(root, signal, ['bundle', 'create', file, 'HEAD']);
    return (await readFile(file)).toString('base64');
  } finally {
    await rm(file, { force: true });
  }
}
export async function importBundle(
  root: string,
  source: { masterCommit: string | null; bundleBase64: string | null },
  signal: AbortSignal,
) {
  if (!source.masterCommit || !source.bundleBase64)
    throw new CliError(
      'source_empty',
      'Resource has no published source. Use its original create workspace to make the first deployment.',
      6,
    );
  const file = join(root, '.git', `hatch-source-${randomUUID()}.bundle`);
  try {
    await writeFile(file, Buffer.from(source.bundleBase64, 'base64'), {
      flag: 'wx',
    });
    await git(root, signal, ['bundle', 'verify', file]);
    await git(root, signal, ['fetch', '--no-tags', file, 'refs/heads/master']);
    const actual = (await git(root, signal, ['rev-parse', 'FETCH_HEAD']))
      .stdout;
    if (actual !== source.masterCommit)
      throw new CliError(
        'source_changed',
        'Source commit and bundle disagree. Fetch again; local files were preserved.',
        6,
      );
    await safeTree(root, signal, actual);
    return actual;
  } finally {
    await rm(file, { force: true });
  }
}
