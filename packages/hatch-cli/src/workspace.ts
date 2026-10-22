/** Standalone source workspaces. Locks survive crashes; no authored work is reset. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  join,
  resolve,
  basename,
  parse,
  relative,
  isAbsolute,
} from 'node:path';
import { CliError } from './error';
import type { Profile } from './config';
import { platformClient } from './client';
import { pnpmInvocation } from './pnpm';
import { prepareApp } from './preparation';

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
import { command, git } from './process';
export { command, git, childEnvironment } from './process';

export async function canonicalTarget(target: string) {
  const absolute = resolve(target);
  if (
    absolute
      .split(/[\\/]/)
      .some((part) =>
        ['.git', '.hatch', 'node_modules'].includes(part.toLowerCase()),
      )
  )
    throw new CliError(
      'unsafe_target',
      'Checkout target overlaps a managed directory.',
      6,
    );
  if (absolute === parse(absolute).root)
    throw new CliError(
      'unsafe_target',
      'Filesystem root cannot be a checkout.',
      6,
    );
  let ancestor = absolute;
  while (ancestor !== dirname(ancestor)) {
    const info = await lstat(ancestor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new CliError(
        'unsafe_target',
        'Checkout paths must not traverse symlinks.',
        6,
      );
    ancestor = dirname(ancestor);
  }
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
export async function assertReplacementSafe(root: string, workdir: string) {
  const relativeWorkdir = relative(root, await realpath(workdir));
  if (
    relativeWorkdir === '' ||
    (!isAbsolute(relativeWorkdir) &&
      relativeWorkdir !== '..' &&
      !relativeWorkdir.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      )) ||
    dirname(root) === parse(root).root ||
    root === process.env.HOME
  )
    throw new CliError(
      'unsafe_target',
      'Workspace root cannot be replaced.',
      6,
    );
  const info = await lstat(root).catch(() => null);
  if (info && !info.isDirectory())
    throw new CliError(
      'unsafe_target',
      'Replace only an explicitly identified directory.',
      6,
    );
  async function inspect(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (await lstat(join(child, '.git')).catch(() => null))
        throw new CliError(
          'unsafe_target',
          'Target contains a nested Git checkout; identify that checkout explicitly.',
          6,
        );
      await inspect(child);
    }
  }
  if (info) await inspect(root);
}
export async function checkoutView(
  root: string,
  metadata: Workspace,
  signal: AbortSignal,
  extra: Record<string, unknown> = {},
) {
  const status = (await git(root, signal, ['status', '--short'])).stdout;
  const head = await git(root, signal, ['rev-parse', '--verify', 'HEAD'], true);
  return {
    id: metadata.id,
    directory: root,
    path: root,
    absolutePath: root,
    generation: metadata.generation,
    headCommit: head.code === 0 ? head.stdout : null,
    masterCommit: metadata.masterCommit,
    remoteCommit: metadata.masterCommit,
    dirty: status.length > 0,
    status,
    replacedExisting: false,
    synchronizedExisting: false,
    preparation: 'ready',
    ...extra,
  };
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
  const file = await open(
    join(root, '.git', 'hatch-cli.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new CliError(
      'invalid_workspace',
      'Missing CLI workspace metadata. Clone/create with hatch first.',
    );
  });
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
    const info = await lstat(dirname(exclude));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new CliError(
        'invalid_workspace',
        '.git/info must be a real directory.',
        6,
      );
    const handle = await open(
      exclude,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new CliError(
          'invalid_workspace',
          '.git/info/exclude must be a regular file.',
          6,
        );
      await handle.writeFile(
        '\n.hatch/\n.hatch-stage-*/\n.hatch-backup-*/\nnode_modules/\ngen/\n',
      );
    } finally {
      await handle.close();
    }
    if (kind === 'app') {
      await prepareApp(root, signal, payload.tooling);
      return;
    }
    // pnpm can succeed in a directory with no package.json. That is not a
    // prepared Workflow: keep an empty checkout recoverable and name the stage.
    const packageFile = await lstat(join(root, 'package.json')).catch(
      () => null,
    );
    if (!packageFile?.isFile() || packageFile.isSymbolicLink())
      throw new CliError(
        'workflow_preparation_failed',
        'Workflow preparation failed during dependency install: missing regular package.json. Add authored inputs and retry update.',
        6,
      );
    try {
      const pnpm = await pnpmInvocation();
      await command(
        pnpm.executable,
        [...pnpm.prefix, 'install', '--ignore-scripts', '--lockfile=false'],
        root,
        signal,
      );
    } catch (error) {
      throw new CliError(
        'workflow_preparation_failed',
        `Workflow preparation failed during dependency install: ${error instanceof CliError ? error.message : 'Invalid source.'}`,
        signal.aborted ? 130 : 6,
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
  if (Boolean(source.masterCommit) !== Boolean(source.bundleBase64))
    throw new CliError(
      'source_changed',
      'Source commit and bundle disagree.',
      6,
    );
  if (!source.masterCommit || !source.bundleBase64) return null;
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
