/** Frozen source preparation without platform server imports or credentials. */
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rm,
  mkdir,
  mkdtemp,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceManifestSchema } from '../../hatch-manifest/src/app-schema.js';
import { sourceWorkflowManifestSchema } from '../../hatch-manifest/src/workflow-schema.js';
import { isAppManagedPathSegment } from '../../../src/app-managed-path';
import { validateDenoDependencySource } from '../../../src/deno-dependencies';
import {
  MANIFEST_SERIALIZER,
  MANIFEST_RESULT,
} from '../../../src/manifest-evaluation';
import { CliError } from './error';
import { command, childEnvironment } from './process';
import type { Kind } from './workspace';
import { pnpmInvocation } from './pnpm';

function inside(root: string, target: string) {
  const path = relative(root, target);
  return (
    path === '' ||
    (!isAbsolute(path) &&
      path !== '..' &&
      !path.startsWith('../') &&
      !path.startsWith('..\\'))
  );
}
async function preflight(root: string, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      directory === root &&
      ['.git', '.hatch', 'node_modules', 'gen'].includes(entry.name)
    ) {
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error(`${entry.name} must be a real directory.`);
      continue;
    }
    if (entry.isSymbolicLink() || isAppManagedPathSegment(entry.name))
      throw new Error('Source contains a symlink or reserved managed path.');
    if (entry.isDirectory()) await preflight(root, join(directory, entry.name));
  }
}
async function trustedEnv(root: string) {
  const env = childEnvironment();
  const entries: string[] = [];
  for (const path of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(path)) continue;
    const canonical = await realpath(path).catch(() => null);
    if (canonical && !inside(root, canonical)) entries.push(canonical);
  }
  env.PATH = [...new Set(entries)].join(delimiter);
  return env;
}
export async function readWorkspaceManifest(
  root: string,
  kind: Kind,
  signal: AbortSignal,
) {
  const ts = await lstat(join(root, 'manifest.ts')).catch(() => null);
  const json = await lstat(join(root, 'manifest.json')).catch(() => null);
  if (Boolean(ts) === Boolean(json))
    throw new Error('Keep exactly one manifest.ts or manifest.json.');
  const file = ts ? 'manifest.ts' : 'manifest.json';
  const entry = ts ?? json;
  if (!entry?.isFile() || entry.isSymbolicLink())
    throw new Error('Manifest must be a regular file.');
  const parse = (value: unknown) =>
    kind === 'app'
      ? sourceManifestSchema.parse(value)
      : sourceWorkflowManifestSchema.parse(value);
  if (json) return parse(JSON.parse(await readFile(join(root, file), 'utf8')));
  const env = await trustedEnv(root);
  const flags = [
    '--config=deno.json',
    '--no-remote',
    kind === 'workflow'
      ? '--node-modules-dir=none'
      : '--node-modules-dir=manual',
    '--import-map=.hatch/import-map.json',
    '--lock=deno.lock',
    '--frozen',
  ];
  const graph = JSON.parse(
    (
      await command(
        'deno',
        ['info', '--json', ...flags, file],
        root,
        signal,
        false,
        { env },
      )
    ).stdout,
  ) as { modules?: { specifier: string; error?: string }[] };
  if (!graph.modules) throw new Error('Manifest dependency graph is missing.');
  for (const module of graph.modules) {
    if (module.error) throw new Error('Manifest dependency graph is invalid.');
    if (module.specifier.startsWith('file:')) {
      if (!inside(root, await realpath(fileURLToPath(module.specifier))))
        throw new Error('Manifest import escapes source root.');
    } else if (!module.specifier.startsWith('npm:'))
      throw new Error('Unsupported manifest import.');
  }
  await command('deno', ['check', ...flags, file], root, signal, false, {
    env,
  });
  // Bundle before evaluating so the trusted serializer captures intrinsics
  // before authored modules run. Evaluation has no source or npm access.
  // Agent SDK generations can be read-only. Evaluation scratch belongs in
  // writable Git metadata, not inside the protected platform-owned SDK.
  const temporary = await mkdtemp(join(root, '.git', 'hatch-manifest-eval-'));
  let result;
  try {
    const entry = join(temporary, 'entry.ts');
    await writeFile(
      entry,
      "import manifest from '../../manifest.ts';\ndeclare const __hatchSerialize: (value: unknown) => void;\n__hatchSerialize(manifest);",
    );
    const bundled = await command(
      'deno',
      ['bundle', ...flags, '--platform=deno', entry],
      root,
      signal,
      false,
      { env },
    );
    if (Buffer.byteLength(bundled.stdout) > 1000000)
      throw new Error('Manifest bundle exceeds its output budget.');
    result = await command(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--no-prompt',
        '-',
      ],
      root,
      signal,
      false,
      { env, input: `${MANIFEST_SERIALIZER}\n${bundled.stdout}` },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const line = result.stdout
    .split('\n')
    .find((value) => value.startsWith(MANIFEST_RESULT));
  if (!line) throw new Error('Manifest did not produce JSON data.');
  return parse(JSON.parse(line.slice(MANIFEST_RESULT.length)));
}
export async function prepareApp(
  root: string,
  signal: AbortSignal,
  tooling?: { bufVersion: string; protocGenEsVersion: string },
) {
  let stage = 'source preflight';
  try {
    await preflight(root);
    await validateDenoDependencySource(root, 'app');
    const env = await trustedEnv(root);
    stage = 'dependency install';
    await command(
      'deno',
      [
        'install',
        '--no-config',
        '--package-json',
        '--node-modules-dir=auto',
        '--lock=deno.lock',
        '--frozen',
      ],
      root,
      signal,
      false,
      { env },
    );
    stage = 'manifest validation';
    const manifest = await readWorkspaceManifest(root, 'app', signal);
    stage = 'Connect codegen';
    if ('rpc' in manifest && manifest.rpc) {
      if (!tooling) throw new Error('Platform codegen versions are missing.');
      const pnpm = await pnpmInvocation(process.platform, env);
      // Only platform-pinned tools, using platform-authored configuration.
      await command(
        pnpm.executable,
        [
          ...pnpm.prefix,
          'dlx',
          '--allow-build',
          '@bufbuild/buf',
          '--package',
          `@bufbuild/buf@${tooling.bufVersion}`,
          '--package',
          `@bufbuild/protoc-gen-es@${tooling.protocGenEsVersion}`,
          'buf',
          'generate',
          '--template',
          '.hatch/buf.gen.yaml',
        ],
        root,
        signal,
        false,
        { env },
      );
    } else {
      await rm(join(root, 'gen'), { recursive: true, force: true });
      await mkdir(join(root, 'gen'));
    }
  } catch (error) {
    const detail =
      error instanceof CliError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Invalid source.';
    throw new CliError(
      'app_preparation_failed',
      `App preparation failed during ${stage}: ${detail}`,
      signal.aborted ? 130 : 6,
    );
  }
}
