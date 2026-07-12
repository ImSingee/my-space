/** Workspace file tools: list, read, write, and exact-string edit. */
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { MAX_FILE_CHARS, text, tool, unwrap } from './shared';

function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function toWorkspacePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
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

async function resolveReadablePath(
  env: ExecutionEnv,
  inputPath: string,
  readOnlyRoots: readonly string[],
  expectedKind: 'file' | 'directory',
  signal?: AbortSignal,
): Promise<ResolvedPath> {
  const [workspaceRoot, canonicalPath, extraRoots] = await Promise.all([
    canonicalWorkspaceRoot(env, signal),
    unwrap(await env.canonicalPath(inputPath, signal)),
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
  const [root, canonicalPath] = await Promise.all([
    canonicalWorkspaceRoot(env, signal),
    unwrap(await env.canonicalPath(inputPath, signal)),
  ]);
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
): Promise<{ workspacePath: string }> {
  const root = await canonicalWorkspaceRoot(env, signal);
  const addressedRoot = unwrap(await env.absolutePath('.', signal));
  const absolutePath = unwrap(await env.absolutePath(inputPath, signal));

  const exists = unwrap(await env.exists(absolutePath, signal));
  if (exists) {
    const existing = await resolveWorkspaceTextFile(env, absolutePath, signal);
    return { workspacePath: existing.workspacePath };
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

  if (isInsidePath(root, absolutePath)) {
    return { workspacePath: toWorkspacePath(root, absolutePath) };
  }
  if (isInsidePath(addressedRoot, absolutePath)) {
    return { workspacePath: toWorkspacePath(addressedRoot, absolutePath) };
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
      });
    },
  });

  const readFile = tool({
    name: 'read_file',
    label: 'Read file',
    description:
      'Read a UTF-8 text file in the workspace, or an absolute file under a ' +
      'read-only resource root referenced by the system prompt.',
    executionMode: 'sequential',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read.' }),
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
      const truncated = content.length > MAX_FILE_CHARS;
      return text(truncated ? content.slice(0, MAX_FILE_CHARS) : content, {
        path: resolved.displayPath,
        truncated,
      });
    },
  });

  const writeFile = tool({
    name: 'write_file',
    label: 'Write file',
    description:
      'Create or overwrite a text file (parent directories are created).',
    executionMode: 'sequential',
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
      return text(
        `Edited ${resolved.workspacePath}: replaced ${count} occurrence(s).`,
        {
          path: resolved.workspacePath,
          replacements: count,
        },
      );
    },
  });

  return [listFiles, readFile, editFile, writeFile];
}
