import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
const commit = '1234567890abcdef1234567890abcdef12345678';
const commitTime = '2026-10-14T23:35:44+08:00';
let directory: string;
let binary: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hatch-cli-version-'));
  for (const name of [
    'package.json',
    'tsconfig.json',
    'LICENSE.md',
    'scripts/build-cli.ts',
    'scripts/build-info.ts',
    'src',
    'packages/hatch-manifest',
    'packages/hatch-platform-api',
    'packages/hatch-cli/package.json',
    'packages/hatch-cli/src',
  ]) {
    const destination = join(directory, name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination, { recursive: true });
  }
  await symlink(
    join(root, 'node_modules'),
    join(directory, 'node_modules'),
    'junction',
  );
  binary = join(directory, 'packages/hatch-cli/dist/main.mjs');
  execFileSync(
    process.execPath,
    [tsx, join(directory, 'scripts/build-cli.ts')],
    {
      cwd: directory,
      env: {
        ...process.env,
        HATCH_BUILD_COMMIT: commit,
        HATCH_BUILD_COMMIT_TIME: commitTime,
      },
      stdio: 'pipe',
    },
  );
}, 30_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('reports the binary revision offline and ignores runtime build overrides', () => {
  const invoke = (args: string[]) =>
    execFileSync(process.execPath, [binary, ...args], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        HATCH_BUILD_COMMIT: 'runtime-must-not-override',
        HATCH_BUILD_COMMIT_TIME: 'bad-runtime-time',
      },
    }).trim();
  const expected = { version: manifest.version, commit, commitTime };
  expect(JSON.parse(invoke(['version', '--json']))).toEqual(expected);
  expect(JSON.parse(invoke(['--json', '--version']))).toEqual(expected);
  expect(invoke(['version'])).toBe(
    `${manifest.version}\nCommit: ${commit.slice(0, 12)}\nCommit time: ${commitTime}`,
  );
  expect(invoke(['--version'])).toBe(invoke(['version']));
});
