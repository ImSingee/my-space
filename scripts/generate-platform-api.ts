/** Generate from locked Buf dependencies; check without changing tracked files. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('packages/hatch-platform-api');
const check = process.argv.includes('--check');
const output = check
  ? await mkdtemp(path.join(tmpdir(), 'hatch-api-codegen-'))
  : root;
async function snapshot(
  directory: string,
  relative = '',
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory())
      Object.assign(result, await snapshot(directory, child));
    else result[child] = await readFile(path.join(directory, child), 'utf8');
  }
  return result;
}
try {
  execFileSync('pnpm', ['exec', 'buf', 'lint', root], { stdio: 'inherit' });
  execFileSync(
    'pnpm',
    ['exec', 'buf', 'format', '--diff', '--exit-code', root],
    { stdio: 'inherit' },
  );
  execFileSync(
    'pnpm',
    [
      'exec',
      'buf',
      'generate',
      root,
      '--template',
      path.join(root, 'buf.gen.yaml'),
      '--output',
      output,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('pnpm', ['exec', 'oxfmt', '--write', path.join(output, 'gen')], {
    stdio: 'inherit',
  });
  if (check) {
    const expected = await snapshot(path.join(output, 'gen'));
    const actual = await snapshot(path.join(root, 'gen'));
    if (
      JSON.stringify(Object.entries(expected).sort()) !==
      JSON.stringify(Object.entries(actual).sort())
    )
      throw new Error(
        'Platform API generated code is stale. Run pnpm platform-api:generate.',
      );
  }
} finally {
  if (check) await rm(output, { recursive: true, force: true });
}
