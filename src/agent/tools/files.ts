/** Workspace file tools: list, read, write, and exact-string edit. */
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { isAppManagedPathSegment } from '~/app-managed-path';
import { isEditFileDetails } from '../edit-file-details';
import { type FilePathDetails, isFilePathDetails } from '../file-path-details';
import { isWriteFileDetails } from '../write-file-details';
import { generateEditFileDetails } from './edit-diff';
import { MAX_FILE_CHARS, text, tool, unwrap } from './shared';

function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function toWorkspacePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function toRelativeDisplayPath(root: string, target: string): string {
  return toWorkspacePath(root, target) || '.';
}

function filePathDetails(root: string, absolutePath: string): FilePathDetails {
  return {
    relativePath: toRelativeDisplayPath(root, absolutePath),
    absolutePath,
  };
}

function inputFilePathDetails(
  env: ExecutionEnv,
  inputPath: unknown,
  readOnlyRoots: readonly string[] = [],
): FilePathDetails | undefined {
  if (typeof inputPath !== 'string') return undefined;
  const workspaceRoot = path.resolve(env.cwd);
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceRoot, inputPath);
  const roots = [
    workspaceRoot,
    ...readOnlyRoots.map((root) =>
      path.isAbsolute(root)
        ? path.resolve(root)
        : path.resolve(workspaceRoot, root),
    ),
  ];
  const containingRoot = roots.find((root) => isInsidePath(root, absolutePath));
  return filePathDetails(containingRoot ?? workspaceRoot, absolutePath);
}

function assertNotPlatformManagedPath(
  workspaceRoot: string,
  target: string,
): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return;
  }
  if (relative.split(path.sep).some(isAppManagedPathSegment)) {
    throw new Error(
      `${toWorkspacePath(workspaceRoot, target)} is inside the platform-owned .hatch directory.`,
    );
  }
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(needle, index);
    if (index < 0) return count;
    count += 1;
    index += needle.length;
  }
}

function splitsSurrogatePair(content: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= content.length) return false;
  const before = content.charCodeAt(boundary - 1);
  const after = content.charCodeAt(boundary);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

function completeUnicodeBoundary(content: string, end: number): number {
  return splitsSurrogatePair(content, end) ? end + 1 : end;
}

function validateUnicodeBoundary(content: string, offset: number): void {
  if (!splitsSurrogatePair(content, offset)) return;
  throw new Error(
    `Invalid offset ${offset}: it falls inside a UTF-16 surrogate pair. ` +
      `Use offset=${offset - 1} or offset=${offset + 1}.`,
  );
}

function applyExactReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; count: number } {
  if (!oldString) throw new Error('old_string must not be empty.');
  if (oldString === newString) {
    throw new Error('old_string and new_string are identical.');
  }
  const count = countOccurrences(content, oldString);
  if (count === 0) {
    throw new Error('old_string was not found in the current file.');
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matched ${count} times. Provide a shorter unique ` +
        'old_string, or set replace_all to true.',
    );
  }
  const index = content.indexOf(oldString);
  return {
    updated: replaceAll
      ? content.split(oldString).join(newString)
      : `${content.slice(0, index)}${newString}${content.slice(
          index + oldString.length,
        )}`,
    count: replaceAll ? count : 1,
  };
}

async function canonicalWorkspaceRoot(
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<string> {
  return unwrap(await env.canonicalPath('.', signal));
}

type ResolvedPath = {
  canonicalPath: string;
  displayPath: string;
  relativePath: string;
};

async function canonicalReadOnlyRoots(
  env: ExecutionEnv,
  roots: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  return Promise.all(
    roots.map(async (root) => unwrap(await env.canonicalPath(root, signal))),
  );
}

async function canonicalReadableTarget(
  env: ExecutionEnv,
  inputPath: string,
  expectedKind: 'file' | 'directory',
  signal?: AbortSignal,
): Promise<string> {
  const result = await env.canonicalPath(inputPath, signal);
  if (!result.ok && result.error.code === 'not_found') {
    throw new Error(
      `${expectedKind === 'file' ? 'File' : 'Directory'} not found: ${inputPath}`,
    );
  }
  return unwrap(result);
}

async function resolveReadablePath(
  env: ExecutionEnv,
  inputPath: string,
  readOnlyRoots: readonly string[],
  expectedKind: 'file' | 'directory',
  signal?: AbortSignal,
): Promise<ResolvedPath> {
  const [workspaceRoot, canonicalPath, extraRoots] = await Promise.all([
    canonicalWorkspaceRoot(env, signal),
    canonicalReadableTarget(env, inputPath, expectedKind, signal),
    canonicalReadOnlyRoots(env, readOnlyRoots, signal),
  ]);
  const containingRoot = [workspaceRoot, ...extraRoots].find((root) =>
    isInsidePath(root, canonicalPath),
  );
  if (!containingRoot) {
    throw new Error(
      `${inputPath} is outside the workspace and configured read-only roots.`,
    );
  }
  const info = unwrap(await env.fileInfo(canonicalPath, signal));
  if (info.kind !== expectedKind) {
    throw new Error(
      expectedKind === 'file'
        ? `${inputPath} is not a regular file.`
        : `${inputPath} is not a directory.`,
    );
  }
  return {
    canonicalPath,
    relativePath: toRelativeDisplayPath(containingRoot, canonicalPath),
    displayPath:
      containingRoot === workspaceRoot
        ? toWorkspacePath(workspaceRoot, canonicalPath)
        : canonicalPath,
  };
}

async function resolveWorkspaceTextFile(
  env: ExecutionEnv,
  inputPath: string,
  signal?: AbortSignal,
): Promise<{ workspacePath: string; canonicalPath: string }> {
  const [root, addressedRoot, absolutePath] = await Promise.all([
    canonicalWorkspaceRoot(env, signal),
    env.absolutePath('.', signal).then(unwrap),
    env.absolutePath(inputPath, signal).then(unwrap),
  ]);
  assertNotPlatformManagedPath(addressedRoot, absolutePath);
  const canonicalPath = unwrap(await env.canonicalPath(absolutePath, signal));
  if (!isInsidePath(root, canonicalPath)) {
    throw new Error(`${inputPath} is outside the workspace.`);
  }
  const info = unwrap(await env.fileInfo(canonicalPath, signal));
  if (info.kind !== 'file') {
    throw new Error(`${inputPath} is not a regular file.`);
  }
  return {
    workspacePath: toWorkspacePath(root, canonicalPath),
    canonicalPath,
  };
}

async function resolveWritableTextFile(
  env: ExecutionEnv,
  inputPath: string,
  signal?: AbortSignal,
): Promise<{
  workspacePath: string;
  canonicalPath: string;
  relativePath: string;
}> {
  const root = await canonicalWorkspaceRoot(env, signal);
  const addressedRoot = unwrap(await env.absolutePath('.', signal));
  const absolutePath = unwrap(await env.absolutePath(inputPath, signal));

  // Check the path the caller addressed before resolving symlinks. Otherwise
  // `app/.hatch -> ../ordinary-directory` would canonicalize to an ordinary
  // workspace path and bypass the managed-path guard for an existing file.
  assertNotPlatformManagedPath(addressedRoot, absolutePath);

  const exists = unwrap(await env.exists(absolutePath, signal));
  if (exists) {
    const existing = await resolveWorkspaceTextFile(env, absolutePath, signal);
    assertNotPlatformManagedPath(root, existing.canonicalPath);
    return { ...existing, relativePath: existing.workspacePath };
  }

  let parent = path.dirname(absolutePath);
  while (!unwrap(await env.exists(parent, signal))) {
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }

  const parentInfo = unwrap(await env.fileInfo(parent, signal));
  if (parentInfo.kind !== 'directory') {
    throw new Error(`Parent path for ${inputPath} is not a directory.`);
  }
  const canonicalParent = unwrap(await env.canonicalPath(parent, signal));
  if (!isInsidePath(root, canonicalParent)) {
    throw new Error(`${inputPath} is outside the workspace.`);
  }
  const canonicalTarget = path.resolve(
    canonicalParent,
    path.relative(parent, absolutePath),
  );
  assertNotPlatformManagedPath(root, canonicalTarget);

  if (isInsidePath(root, absolutePath)) {
    assertNotPlatformManagedPath(root, absolutePath);
    return {
      workspacePath: toWorkspacePath(root, absolutePath),
      canonicalPath: canonicalTarget,
      relativePath: toWorkspacePath(root, canonicalTarget),
    };
  }
  if (isInsidePath(addressedRoot, absolutePath)) {
    return {
      workspacePath: toWorkspacePath(addressedRoot, absolutePath),
      canonicalPath: canonicalTarget,
      relativePath: toWorkspacePath(root, canonicalTarget),
    };
  }
  throw new Error(`${inputPath} is outside the workspace.`);
}

export type CreateFileToolsOptions = {
  readOnlyRoots?: string[];
};

export function createFileTools(
  env: ExecutionEnv,
  options: CreateFileToolsOptions = {},
): AgentTool[] {
  const readOnlyRoots = options.readOnlyRoots ?? [];
  const listFiles = tool({
    name: 'list_files',
    label: 'List files',
    description:
      'List a directory in the workspace, or an absolute directory under a ' +
      'read-only resource root referenced by the system prompt.',
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Directory path. Defaults to ".".' }),
      ),
    }),
    selectStreamStartDetails: (args) =>
      inputFilePathDetails(
        env,
        Object.hasOwn(args, 'path') ? args.path : '.',
        readOnlyRoots,
      ),
    selectStreamDetails: (details) =>
      isFilePathDetails(details) ? details : undefined,
    execute: async (_id, params, signal) => {
      const resolved = await resolveReadablePath(
        env,
        params.path ?? '.',
        readOnlyRoots,
        'directory',
        signal,
      );
      const entries = unwrap(await env.listDir(resolved.canonicalPath, signal));
      const lines = entries
        .map((e) => `${e.kind === 'directory' ? 'd' : '-'} ${e.name}`)
        .sort();
      return text(lines.join('\n') || '(empty)', {
        count: entries.length,
        path: resolved.displayPath,
        relativePath: resolved.relativePath,
        absolutePath: resolved.canonicalPath,
      });
    },
  });

  const readFile = tool({
    name: 'read_file',
    label: 'Read file',
    description:
      'Read a page of a UTF-8 text file in the workspace, or an absolute file ' +
      'under a read-only resource root referenced by the system prompt. When ' +
      'the result is truncated, call again with the returned offset.',
    executionMode: 'sequential',
    selectStreamStartDetails: (args) =>
      inputFilePathDetails(env, args.path, readOnlyRoots),
    selectStreamDetails: (details) =>
      isFilePathDetails(details) ? details : undefined,
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read.' }),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            'Zero-based UTF-16 offset. Must not split a surrogate pair. ' +
            'Defaults to 0.',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_FILE_CHARS,
          description: `Maximum characters to return. Defaults to ${MAX_FILE_CHARS}.`,
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const resolved = await resolveReadablePath(
        env,
        params.path,
        readOnlyRoots,
        'file',
        signal,
      );
      const content = unwrap(
        await env.readTextFile(resolved.canonicalPath, signal),
      );
      const offset = params.offset ?? 0;
      const limit = params.limit ?? MAX_FILE_CHARS;
      validateUnicodeBoundary(content, offset);
      const requestedEnd = Math.min(offset + limit, content.length);
      const nextOffset = completeUnicodeBoundary(content, requestedEnd);
      const page = content.slice(offset, nextOffset);
      const truncated = nextOffset < content.length;
      const output = truncated
        ? `${page}${page.endsWith('\n') ? '\n' : '\n\n'}` +
          `[File content truncated. Continue reading with offset=${nextOffset}.]`
        : page;
      return text(output, {
        path: resolved.displayPath,
        relativePath: resolved.relativePath,
        absolutePath: resolved.canonicalPath,
        offset,
        limit,
        truncated,
        ...(truncated ? { nextOffset } : {}),
      });
    },
  });

  const writeFile = tool({
    name: 'write_file',
    label: 'Write file',
    description:
      'Create or overwrite a text file (parent directories are created).',
    executionMode: 'sequential',
    selectStreamStartDetails: (args) => inputFilePathDetails(env, args.path),
    selectStreamDetails: (details) =>
      isWriteFileDetails(details) || isFilePathDetails(details)
        ? details
        : undefined,
    parameters: Type.Object({
      path: Type.String({ description: 'File path to write.' }),
      content: Type.String({ description: 'Full file contents.' }),
    }),
    execute: async (_id, params, signal) => {
      const writable = await resolveWritableTextFile(env, params.path, signal);
      unwrap(await env.writeFile(params.path, params.content, signal));
      return text(
        `Wrote ${writable.workspacePath} (${params.content.length} chars).`,
        {
          path: writable.workspacePath,
          relativePath: writable.relativePath,
          absolutePath: writable.canonicalPath,
        },
      );
    },
  });

  const editFile = tool({
    name: 'edit_file',
    label: 'Edit file',
    description:
      'Edit an existing UTF-8 text file by replacing an exact string. ' +
      'Read the file first so old_string can be copied exactly.',
    executionMode: 'sequential',
    selectStreamStartDetails: (args) => inputFilePathDetails(env, args.path),
    selectStreamDetails: (details) =>
      isEditFileDetails(details) || isFilePathDetails(details)
        ? details
        : undefined,
    parameters: Type.Object({
      path: Type.String({ description: 'File path to edit.' }),
      old_string: Type.String({
        description:
          'Exact text to replace. Keep it as short as possible while unique.',
      }),
      new_string: Type.String({ description: 'Replacement text.' }),
      replace_all: Type.Optional(
        Type.Boolean({
          description: 'Replace every occurrence of old_string.',
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const resolved = await resolveWorkspaceTextFile(env, params.path, signal);
      const root = await canonicalWorkspaceRoot(env, signal);
      assertNotPlatformManagedPath(root, resolved.canonicalPath);
      const content = unwrap(
        await env.readTextFile(resolved.canonicalPath, signal),
      );
      const { updated, count } = applyExactReplacement(
        content,
        params.old_string,
        params.new_string,
        params.replace_all ?? false,
      );
      unwrap(await env.writeFile(resolved.canonicalPath, updated, signal));
      const details = generateEditFileDetails({
        path: resolved.workspacePath,
        relativePath: resolved.workspacePath,
        absolutePath: resolved.canonicalPath,
        replacements: count,
        oldContent: content,
        newContent: updated,
      });
      return text(
        `Edited ${resolved.workspacePath}: replaced ${count} occurrence(s).`,
        details,
      );
    },
  });

  return [listFiles, readFile, editFile, writeFile];
}
