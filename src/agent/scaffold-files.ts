/**
 * Write a platform-rendered scaffold file map to disk. Used by the Agent
 * Runner (writing a new app/workflow template into its local worktree) and by
 * platform-side scripts. Validates every path against traversal even though
 * the platform only produces safe ones — the runner treats the payload as
 * untrusted input.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeRelativePath, type ScaffoldFile } from './protocol';

export async function writeScaffoldFiles(
  root: string,
  files: ScaffoldFile[],
): Promise<void> {
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      throw new Error(`Unsafe scaffold file path: ${file.path}`);
    }
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.contentBase64, 'base64'));
  }
}
