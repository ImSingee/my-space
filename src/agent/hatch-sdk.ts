/** Platform-owned SDK materialization for Hatch source worktrees. */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { APP_MANAGED_DIR, isAppManagedPathSegment } from '../app-managed-path';
import { PLATFORM_APP_BUF_GEN_YAML } from './app-codegen';
import type { WorktreeMaterializer } from './worktree-materializer';
import {
  AGENTS_DIR,
  HATCH_SDK_STAGING_DIR,
  REPO_ROOT,
  WORKSPACE_ROOT,
} from './paths';
import { resolveAgentOwnershipSession, sandboxSpawn } from './shell-sandbox';

const HATCH_DATA_SOURCE_DIR = path.join(REPO_ROOT, 'packages', 'hatch-data');
const HATCH_WORKFLOW_SOURCE_DIR = path.join(
  REPO_ROOT,
  'packages',
  'hatch-workflow',
);

export const HATCH_SDK_IMPORT_MAP = '.hatch/import-map.json';
export const HATCH_BUF_GEN_CONFIG = '.hatch/buf.gen.yaml';

export const APP_HATCH_SDK_IMPORTS = {
  '@hatch/data': './sdk/@hatch/data/dist/data.js',
  '@hatch/data/react': './sdk/@hatch/data/dist/data-react.js',
} as const;

export const WORKFLOW_HATCH_SDK_IMPORTS = {
  '@hatch/workflow': './sdk/@hatch/workflow/dist/workflow.js',
} as const;

export function appHatchDataPackageDir(root: string): string {
  return path.join(root, '.hatch', 'sdk', '@hatch', 'data');
}

export function workflowHatchPackageDir(root: string): string {
  return path.join(root, '.hatch', 'sdk', '@hatch', 'workflow');
}

export function hatchImportMapPath(root: string): string {
  return path.join(root, ...HATCH_SDK_IMPORT_MAP.split('/'));
}

function managedPathError(target: string, reason: string): Error {
  return new Error(
    `Cannot materialize the platform-owned Hatch SDK: ${path.basename(
      target,
    )} ${reason}.`,
  );
}

type HatchSdkPackage = {
  sourceDir: string;
  targetName: string;
  buildFiles: readonly string[];
};

type HatchSdkGeneration = {
  label: string;
  sourceRootLabel: string;
  imports: Readonly<Record<string, string>>;
  packages: readonly HatchSdkPackage[];
  extraFiles?: Readonly<Record<string, string>>;
};

const APP_HATCH_SDK_GENERATION: HatchSdkGeneration = {
  label: '@hatch/data',
  sourceRootLabel: 'App source root',
  imports: APP_HATCH_SDK_IMPORTS,
  packages: [
    {
      sourceDir: HATCH_DATA_SOURCE_DIR,
      targetName: 'data',
      buildFiles: [
        'dist/data.js',
        'dist/data.d.ts',
        'dist/data-react.js',
        'dist/data-react.d.ts',
      ],
    },
  ],
  extraFiles: { 'buf.gen.yaml': PLATFORM_APP_BUF_GEN_YAML },
};

const WORKFLOW_HATCH_SDK_GENERATION: HatchSdkGeneration = {
  label: '@hatch/workflow',
  sourceRootLabel: 'Workflow source root',
  imports: WORKFLOW_HATCH_SDK_IMPORTS,
  packages: [
    {
      sourceDir: HATCH_WORKFLOW_SOURCE_DIR,
      targetName: 'workflow',
      buildFiles: ['dist/workflow.js', 'dist/workflow.d.ts'],
    },
  ],
};

async function assertReplaceableManagedDirectory(
  target: string,
): Promise<boolean> {
  await assertCanonicalManagedDirectoryName(path.dirname(target));
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) {
      throw managedPathError(target, 'is a symbolic link');
    }
    if (!entry.isDirectory()) {
      throw managedPathError(target, 'is not a directory');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertCanonicalManagedDirectoryName(
  root: string,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isAppManagedPathSegment(entry.name) && entry.name !== APP_MANAGED_DIR) {
      throw managedPathError(
        path.join(root, entry.name),
        'is a non-canonical case variant of the reserved .hatch directory',
      );
    }
  }
}

async function assertSdkBuildExists(
  generation: HatchSdkGeneration,
): Promise<void> {
  try {
    await Promise.all(
      generation.packages.flatMap((sdkPackage) =>
        sdkPackage.buildFiles.map((file) =>
          access(path.join(sdkPackage.sourceDir, ...file.split('/'))),
        ),
      ),
    );
  } catch {
    throw new Error(
      'Hatch SDK build output is missing. Run `pnpm hatch-sdk:build`.',
    );
  }
}

type DirectoryIdentity = {
  dev: bigint;
  ino: bigint;
  realPath: string;
};

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function installAgentGeneration(
  root: string,
  staged: string,
  expectedFiles: readonly string[],
): Promise<void> {
  const helper = String.raw`
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const [root, expectedRoot, encodedFiles] = process.argv.slice(1);
const files = JSON.parse(Buffer.from(encodedFiles, 'base64url').toString());
if (!Array.isArray(files) || files.length === 0 || files.some((file) =>
  typeof file !== 'string' || !file || path.isAbsolute(file) ||
  file.split('/').some((part) => !part || part === '.' || part === '..'))) {
  throw new Error('Invalid SDK payload manifest.');
}
if (await realpath('.') !== expectedRoot || await realpath(root) !== expectedRoot) {
  throw new Error('Source root changed during SDK install.');
}
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.name.toLowerCase() === '.hatch' && entry.name !== '.hatch') {
    throw new Error(
      'Cannot materialize the platform-owned Hatch SDK: ' + entry.name +
      ' is a non-canonical case variant of the reserved .hatch directory.'
    );
  }
}
const destination = path.join(root, '.hatch');
const temporary = path.join(root, '.hatch-install-' + crypto.randomUUID());
const backup = path.join(root, '.hatch-backup-' + crypto.randomUUID());
let hadDestination = false;
let movedDestination = false;
async function removeTree(target) {
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await rm(target, { force: true });
    return;
  }
  await chmod(target, 0o700);
  for (const child of await readdir(target)) {
    await removeTree(path.join(target, child));
  }
  await rm(target, { recursive: true, force: true });
}
try {
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error('Source root must be a real directory.');
  }
  await mkdir(temporary, { mode: 0o700 });
  for (const relative of files) {
    const target = path.join(temporary, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const handle = await open(target, 'wx', 0o644);
    await handle.close();
  }
  let current = 0;
  let remaining = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    remaining = Buffer.concat([remaining, chunk]);
    while (current < files.length) {
      if (remaining.length < 8) break;
      const size = Number(remaining.readBigUInt64BE(0));
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid SDK payload size.');
      if (remaining.length < 8 + size) break;
      const target = path.join(temporary, ...files[current].split('/'));
      await open(target, 'w').then(async (handle) => {
        try { await handle.writeFile(remaining.subarray(8, 8 + size)); }
        finally { await handle.close(); }
      });
      remaining = remaining.subarray(8 + size);
      current += 1;
    }
  }
  if (current !== files.length || remaining.length !== 0) {
    throw new Error('Incomplete SDK payload.');
  }
  try {
    const destinationEntry = await lstat(destination);
    if (destinationEntry.isSymbolicLink() || !destinationEntry.isDirectory()) {
      throw new Error('.hatch must be a real directory.');
    }
    hadDestination = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (hadDestination) {
    await rename(destination, backup);
    movedDestination = true;
  }
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (movedDestination) await rename(backup, destination);
    throw error;
  }
  await removeTree(backup);
} finally {
  await removeTree(temporary);
}
`;
  const wrapped = sandboxSpawn(
    [
      process.execPath,
      '--input-type=module',
      '--eval',
      helper,
      root,
      root,
      Buffer.from(JSON.stringify(expectedFiles)).toString('base64url'),
    ],
    resolveAgentOwnershipSession([root]),
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: root,
      env: { PATH: process.env.PATH, LANG: process.env.LANG },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.stdin.on('error', (error) => finish(error));
    child.on('error', finish);
    child.on('close', (code) => {
      if (code === 0) finish();
      else {
        finish(
          new Error(
            stderr.trim() ||
              `Sandboxed SDK install exited with status ${code ?? 'unknown'}.`,
          ),
        );
      }
    });
    void (async () => {
      try {
        const writePayload = (chunk: Buffer) =>
          new Promise<void>((resolve, rejectWrite) => {
            if (settled || child.stdin.destroyed) {
              rejectWrite(
                new Error('Sandboxed SDK install closed its payload stream.'),
              );
              return;
            }
            child.stdin.write(chunk, (error) => {
              if (error) rejectWrite(error);
              else resolve();
            });
          });
        for (const relative of expectedFiles) {
          const payload = await open(
            path.join(staged, ...relative.split('/')),
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          try {
            const contents = await payload.readFile();
            const header = Buffer.alloc(8);
            header.writeBigUInt64BE(BigInt(contents.length));
            await writePayload(header);
            await writePayload(contents);
          } finally {
            await payload.close();
          }
        }
        if (!settled) child.stdin.end();
      } catch (error) {
        child.stdin.destroy(error as Error);
        child.kill('SIGKILL');
        finish(error);
      }
    })();
  });
}

async function generationFiles(root: string, relative = ''): Promise<string[]> {
  const current = relative ? path.join(root, ...relative.split('/')) : root;
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw managedPathError(
        child,
        'generated output contains a symbolic link',
      );
    }
    if (entry.isDirectory())
      files.push(...(await generationFiles(root, child)));
    else if (entry.isFile()) files.push(child);
    else
      throw managedPathError(child, 'generated output is not a regular file');
  }
  return files.sort();
}

async function trustedDirectoryIdentity(
  target: string,
  label: string,
): Promise<DirectoryIdentity> {
  const entry = await lstat(target, { bigint: true });
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw managedPathError(target, `${label} must be a real directory`);
  }
  const resolved = await realpath(target);
  return { dev: entry.dev, ino: entry.ino, realPath: resolved };
}

async function assertUnchangedDirectory(
  target: string,
  expected: DirectoryIdentity,
  label: string,
): Promise<void> {
  const current = await trustedDirectoryIdentity(target, label);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.realPath !== expected.realPath
  ) {
    throw managedPathError(target, `${label} changed during materialization`);
  }
}

async function ensureTrustedStagingRoot(): Promise<void> {
  await mkdir(WORKSPACE_ROOT, { recursive: true });
  const workspace = await trustedDirectoryIdentity(
    WORKSPACE_ROOT,
    'workspace root',
  );
  try {
    await mkdir(HATCH_SDK_STAGING_DIR, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertUnchangedDirectory(WORKSPACE_ROOT, workspace, 'workspace root');
  await trustedDirectoryIdentity(HATCH_SDK_STAGING_DIR, 'staging root');
  await chmod(HATCH_SDK_STAGING_DIR, 0o700);
}

async function makePlatformReadOnly(target: string): Promise<void> {
  const entry = await lstat(target);
  if (entry.isSymbolicLink()) {
    throw managedPathError(target, 'generated output contains a symbolic link');
  }
  if (!entry.isDirectory()) {
    await chmod(target, 0o644);
    return;
  }
  for (const child of await readdir(target)) {
    await makePlatformReadOnly(path.join(target, child));
  }
  await chmod(target, 0o755);
}

async function preparePlatformGeneration(
  target: string,
  generationRoot = true,
): Promise<void> {
  const entry = await lstat(target);
  if (entry.isSymbolicLink()) {
    throw managedPathError(target, 'generated output contains a symbolic link');
  }
  if (!entry.isDirectory()) {
    await chmod(target, 0o644);
    return;
  }
  for (const child of await readdir(target)) {
    await preparePlatformGeneration(path.join(target, child), false);
  }
  // APFS refuses to move a non-owner-writable source directory across
  // parents, so only the generation root remains 0700 until its atomic move.
  // Nested directories must never inherit the runner's permissive umask.
  await chmod(target, generationRoot ? 0o700 : 0o755);
}

async function makePlatformRemovable(target: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) return;
  await chmod(target, 0o755);
  for (const child of await readdir(target)) {
    await makePlatformRemovable(path.join(target, child));
  }
}

async function removePlatformGeneration(target: string): Promise<void> {
  await makePlatformRemovable(target);
  await rm(target, { recursive: true, force: true });
}

async function stageSdkGeneration(
  target: string,
  generation: HatchSdkGeneration,
): Promise<void> {
  await mkdir(target, { recursive: true });
  const tasks: Promise<unknown>[] = [
    writeFile(
      path.join(target, 'import-map.json'),
      `${JSON.stringify({ imports: generation.imports }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    ),
  ];
  for (const sdkPackage of generation.packages) {
    const packageTarget = path.join(
      target,
      'sdk',
      '@hatch',
      sdkPackage.targetName,
    );
    await mkdir(packageTarget, { recursive: true });
    tasks.push(
      cp(
        path.join(sdkPackage.sourceDir, 'package.json'),
        path.join(packageTarget, 'package.json'),
      ),
      cp(
        path.join(sdkPackage.sourceDir, 'dist'),
        path.join(packageTarget, 'dist'),
        {
          recursive: true,
        },
      ),
    );
  }
  for (const [file, contents] of Object.entries(generation.extraFiles ?? {})) {
    tasks.push(
      writeFile(path.join(target, file), contents, {
        encoding: 'utf8',
        flag: 'wx',
      }),
    );
  }
  await Promise.all(tasks);
}

/**
 * Refresh one generated SDK without trusting anything already present in the
 * source checkout. SDK packages stay outside the authored dependency graph and
 * resolve through the platform-owned import map generated beside them.
 */
async function materializeHatchSdk(
  root: string,
  generation: HatchSdkGeneration,
): Promise<void> {
  await assertSdkBuildExists(generation);
  const agentWorktree = isInside(AGENTS_DIR, path.resolve(root));
  const destination = path.join(root, '.hatch');
  const rootIdentity = await trustedDirectoryIdentity(
    root,
    generation.sourceRootLabel,
  );
  await assertCanonicalManagedDirectoryName(rootIdentity.realPath);
  await ensureTrustedStagingRoot();
  const operation = await mkdtemp(
    path.join(HATCH_SDK_STAGING_DIR, 'generation-'),
  );
  const temporary = path.join(operation, 'next');
  const backup = path.join(operation, 'previous');
  let preserveBackup = false;
  try {
    await stageSdkGeneration(temporary, generation);
    // Normalize every staged entry before it can become visible. Agent
    // worktrees receive these bytes through the sandbox-UID helper below;
    // non-Agent build roots make the installed generation read-only.
    await preparePlatformGeneration(temporary);
    const stagedIdentity = await lstat(temporary, { bigint: true });
    if (stagedIdentity.dev !== rootIdentity.dev) {
      throw managedPathError(
        destination,
        'cannot be atomically installed across filesystems',
      );
    }

    if (agentWorktree) {
      // All target mutations run with the Agent's own filesystem authority.
      // A detached Agent can race its worktree paths, but cannot turn that
      // race into a privileged write outside paths the Agent already owns.
      await installAgentGeneration(
        rootIdentity.realPath,
        temporary,
        await generationFiles(temporary),
      );
      return;
    }

    // Replace the platform-owned directory as one unit so the SDK and its
    // import map always move to the same generation. Staging and rollback stay
    // outside the Agent-writable source root. Revalidate the complete root path at
    // the replacement boundary; rename moves the `.hatch` entry itself and
    // never traverses a symlink stored at that entry.
    await assertUnchangedDirectory(
      root,
      rootIdentity,
      generation.sourceRootLabel,
    );
    const hadDestination = await assertReplaceableManagedDirectory(destination);
    if (hadDestination) {
      await chmod(destination, 0o755);
      await rename(destination, backup);
    }
    try {
      await assertUnchangedDirectory(
        root,
        rootIdentity,
        generation.sourceRootLabel,
      );
      await rename(temporary, destination);
      await makePlatformReadOnly(destination);
    } catch (error) {
      if (hadDestination) {
        try {
          await assertUnchangedDirectory(
            root,
            rootIdentity,
            generation.sourceRootLabel,
          );
          await rename(backup, destination);
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError(
            [error, restoreError],
            `Cannot install the platform-owned ${generation.label} SDK. The previous generated directory remains in protected staging at ${backup}.`,
          );
        }
      }
      throw error;
    }
  } finally {
    await removePlatformGeneration(temporary);
    if (!preserveBackup) {
      await removePlatformGeneration(backup);
      await rm(operation, { recursive: true, force: true });
    }
  }
}

export function materializeAppHatchSdk(root: string): Promise<void> {
  return materializeHatchSdk(root, APP_HATCH_SDK_GENERATION);
}

export function materializeWorkflowHatchSdk(root: string): Promise<void> {
  return materializeHatchSdk(root, WORKFLOW_HATCH_SDK_GENERATION);
}

const COMMON_HATCH_SDK_EXCLUDES = [
  '/.hatch/',
  '/.hatch-install-*/',
  '/.hatch-backup-*/',
  '/node_modules/',
] as const;

export const appHatchSdkMaterializer = {
  gitExcludePatterns: [...COMMON_HATCH_SDK_EXCLUDES, '/gen/'],
  materialize: materializeAppHatchSdk,
} satisfies WorktreeMaterializer;

export const workflowHatchSdkMaterializer = {
  gitExcludePatterns: COMMON_HATCH_SDK_EXCLUDES,
  materialize: materializeWorkflowHatchSdk,
} satisfies WorktreeMaterializer;
