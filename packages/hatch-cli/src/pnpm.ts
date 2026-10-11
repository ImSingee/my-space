/** Resolve Windows package-manager shims without executing batch-file contents. */
import { stat, realpath, readFile } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, basename } from 'node:path';
import { CliError } from './error';

export async function pnpmInvocation(
  platform = process.platform,
  env = process.env,
): Promise<{ executable: string; prefix: string[] }> {
  if (platform !== 'win32') return { executable: 'pnpm', prefix: [] };
  const path = Object.entries(env).find(
    ([key]) => key.toUpperCase() === 'PATH',
  )?.[1];
  for (const segment of (path ?? '').split(';')) {
    const directory = segment.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const executable = join(directory, 'pnpm.exe');
    if (await isFile(executable)) return { executable, prefix: [] };
    const shim = join(directory, 'pnpm.cmd');
    if (!(await isFile(shim))) continue;
    // npm globals, pnpm/action-setup, and Corepack use these Node entry points.
    const root = dirname(await realpath(shim));
    // pnpm can replace its shim with a version-managed entry point. Interpret
    // only quoted filesystem paths; never evaluate batch commands/variables.
    const contents = await readFile(shim, 'utf8');
    for (const match of contents.matchAll(
      /"([^"\r\n]+(?:\.(?:cjs|mjs|js)|pnpm\.exe))"/gi,
    )) {
      const target = match[1].replace(
        /^%(?:dp0%|~dp0)[\\/]?/i,
        () => `${root}/`,
      );
      if (target.includes('%')) continue;
      const entry = isAbsolute(target) ? target : resolve(root, target);
      if (await isFile(entry))
        return basename(entry).toLowerCase() === 'pnpm.exe'
          ? { executable: entry, prefix: [] }
          : { executable: process.execPath, prefix: [entry] };
    }
    for (const entry of [
      join(root, 'pnpm.cjs'),
      join(root, 'bin', 'pnpm.cjs'),
      join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(root, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      join(root, '..', 'pnpm', 'bin', 'pnpm.cjs'),
      join(root, '..', 'corepack', 'dist', 'pnpm.js'),
    ])
      if (await isFile(entry))
        return { executable: process.execPath, prefix: [entry] };
    throw new CliError(
      'tool_unavailable',
      'Cannot locate the Node entry point for pnpm.cmd. Install pnpm with npm install --global pnpm, Corepack, or the standalone executable.',
      7,
    );
  }
  throw new CliError('tool_unavailable', 'Install pnpm on PATH.', 7);
}

async function isFile(path: string) {
  return stat(path).then(
    (value) => value.isFile(),
    () => false,
  );
}
