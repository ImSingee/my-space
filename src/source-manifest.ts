/** Load authored App/Workflow configuration without executing it in the host. */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
import {
  APP_HATCH_SDK_IMPORTS,
  WORKFLOW_HATCH_SDK_IMPORTS,
  hatchImportMapPath,
} from './agent/hatch-sdk';
import { subprocessSandboxEnv } from './server/sandbox-env';
import { run, type RunOptions, type RunResult } from './server/subprocess';

export type ManifestFile = 'manifest.ts' | 'manifest.json';
export type ManifestRunner = (
  args: string[],
  options: { input?: string; timeoutMs?: number },
) => Promise<RunResult>;
export type ManifestReader = (file: string) => Promise<string | null>;
type SourceKind = 'app' | 'workflow';

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Read only a regular file reached through real directories inside the root. */
export async function readManifestFile(
  root: string,
  file: string,
): Promise<string | null> {
  if (!inside(path.resolve(root), path.resolve(root, file)))
    throw new Error(`Source path escapes its root: ${file}`);
  const parts = file.split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await fs
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (!info) return null;
    if (info.isSymbolicLink())
      throw new Error(`Source must not contain symbolic links: ${file}`);
  }
  const handle = await fs.open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`${file} must be a regular file.`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

export async function detectSourceManifest(
  root: string,
  reader: ManifestReader = (file) => readManifestFile(root, file),
): Promise<ManifestFile> {
  const ts = await reader('manifest.ts');
  const json = await reader('manifest.json');
  if (ts !== null && json !== null)
    throw new Error(
      'Keep exactly one source manifest: manifest.ts or manifest.json, not both.',
    );
  if (ts === null && json === null)
    throw new Error('Source must contain manifest.ts or manifest.json.');
  return ts === null ? 'manifest.json' : 'manifest.ts';
}

export function manifestRunner(
  root: string,
  options: Omit<RunOptions, 'cwd'> = {},
): ManifestRunner {
  return (args, extra) =>
    run('deno', args, {
      ...options,
      cwd: root,
      env: options.env ?? subprocessSandboxEnv(),
      ...extra,
    });
}

const RESULT = '[[hatch-manifest]]';
// Execute before author code; retain the intrinsics needed for data extraction.
const SERIALIZER = String.raw`
const __hatchSerialize = (() => {
  const stringify = JSON.stringify;
  const descriptors = Object.getOwnPropertyDescriptors;
  const prototype = Object.getPrototypeOf;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const create = Object.create;
  const isArray = Array.isArray;
  const keys = Reflect.ownKeys;
  const finite = Number.isFinite;
  const emit = console.log.bind(console);
  return (value) => {
    const ancestors = new Set();
    function copy(item, location) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number' && finite(item)) return item;
      if (typeof item !== 'object') throw new Error(location + ': expected JSON data');
      if (ancestors.has(item)) throw new Error(location + ': circular reference');
      const array = isArray(item);
      const proto = prototype(item);
      if (array ? proto !== arrayPrototype : proto !== objectPrototype && proto !== null) throw new Error(location + ': expected a plain JSON object');
      ancestors.add(item);
      const output = array ? [] : create(null);
      const props = descriptors(item);
      for (const key of keys(props)) {
        if (array && key === 'length') continue;
        const prop = props[key];
        if (typeof key !== 'string' || !prop.enumerable || !('value' in prop)) throw new Error(location + ': unsupported property');
        if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error(location + ': unsupported array property');
        output[key] = copy(prop.value, location + '.' + key);
      }
      if (array && keys(output).length - 1 !== item.length) throw new Error(location + ': sparse arrays are not JSON data');
      ancestors.delete(item);
      return output;
    }
    if (!value || typeof value !== 'object' || isArray(value)) throw new Error('manifest.ts must default-export a plain object');
    emit('${RESULT}' + stringify(copy(value, 'manifest')));
  };
})();
`;

function manifestBundleBoundary(
  root: string,
  kind: SourceKind,
  read: ManifestReader,
): Plugin {
  const imports =
    kind === 'app' ? APP_HATCH_SDK_IMPORTS : WORKFLOW_HATCH_SDK_IMPORTS;
  return {
    name: 'manifest-source-boundary',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'resolved') return;
        const sdk = (imports as Record<string, string>)[args.path];
        const specifier = sdk ? path.resolve(root, '.hatch', sdk) : args.path;
        if (
          !sdk &&
          (/^[a-z][a-z\d+.-]*:/i.test(specifier) ||
            specifier.startsWith('@hatch/'))
        ) {
          throw new Error(`Unsupported manifest import: ${args.path}`);
        }
        const resolved = await plugin.resolve(specifier, {
          kind: args.kind,
          resolveDir: args.resolveDir || root,
          pluginData: 'resolved',
        });
        if (resolved.errors.length) return resolved;
        if (resolved.external || !inside(root, resolved.path))
          throw new Error(`Manifest import escapes source root: ${args.path}`);
        const canonical = await fs.realpath(resolved.path);
        if (!inside(root, canonical))
          throw new Error(`Manifest import escapes source root: ${args.path}`);
        return { path: canonical };
      });
      plugin.onLoad({ filter: /\.[cm]?[jt]sx?$|\.json$/ }, async (args) => {
        if (!inside(root, args.path))
          throw new Error(`Manifest import escapes source root: ${args.path}`);
        const contents = await read(
          path.relative(root, args.path).split(path.sep).join('/'),
        );
        if (contents === null)
          throw new Error(`Missing manifest module: ${args.path}`);
        const extension = path.extname(args.path);
        const loader =
          extension === '.json'
            ? 'json'
            : extension.endsWith('x')
              ? extension === '.tsx'
                ? 'tsx'
                : 'jsx'
              : /\.([cm]?ts)$/.test(extension)
                ? 'ts'
                : 'js';
        return { contents, loader, resolveDir: path.dirname(args.path) };
      });
    },
  };
}

export async function loadSourceManifest<T>(
  root: string,
  options: {
    kind: SourceKind;
    parse: (raw: unknown) => T;
    run?: ManifestRunner;
    read?: ManifestReader;
    logs?: string[];
    evaluationTimeoutMs?: number;
  },
): Promise<{ manifest: T; file: ManifestFile }> {
  const reader = options.read ?? ((file) => readManifestFile(root, file));
  const file = await detectSourceManifest(root, reader);
  try {
    if (file === 'manifest.json') {
      return {
        file,
        manifest: options.parse(JSON.parse((await reader(file))!)),
      };
    }
    const canonicalRoot = await fs.realpath(root);
    const execute = options.run ?? manifestRunner(root);
    const invoke = async (
      args: string[],
      extra: { input?: string; timeoutMs?: number } = {},
    ) => {
      const result = await execute(args, extra);
      if (result.stdout.length > 1_000_000 || result.stderr.length > 1_000_000)
        throw new Error('Manifest command output exceeded the 1 MB limit.');
      if (args[0] !== 'info')
        options.logs?.push(`$ deno ${args.join(' ')}\n${result.output.trim()}`);
      if (result.code !== 0)
        throw new Error(result.output || 'manifest command failed');
      return result;
    };
    const flags = [
      '--config=deno.json',
      '--no-remote',
      '--node-modules-dir=manual',
      `--import-map=${hatchImportMapPath(root)}`,
      '--lock=deno.lock',
      '--frozen',
    ];
    // The graph includes type-only imports that a JS bundler would discard.
    const graph = await invoke(['info', '--json', ...flags, file]);
    const info = JSON.parse(graph.stdout) as {
      modules?: { specifier: string; error?: string }[];
    };
    if (!info.modules) throw new Error('Manifest dependency graph is missing.');
    for (const module of info.modules) {
      if (module.specifier.startsWith('file:')) {
        const target = fileURLToPath(module.specifier);
        if (
          !inside(path.resolve(root), target) &&
          !inside(canonicalRoot, target)
        )
          throw new Error(
            `Manifest import escapes source root: ${module.specifier}`,
          );
        if (!inside(canonicalRoot, await fs.realpath(target)))
          throw new Error(
            `Manifest import escapes source root: ${module.specifier}`,
          );
      } else if (!module.specifier.startsWith('npm:')) {
        throw new Error(`Unsupported manifest import: ${module.specifier}`);
      }
      if (module.error) throw new Error(module.error);
    }
    const bundled = await build({
      absWorkingDir: canonicalRoot,
      stdin: {
        contents: `import manifest from './manifest.ts';\n__hatchSerialize(manifest);`,
        resolveDir: canonicalRoot,
        sourcefile: 'manifest-evaluator.js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      mainFields: ['module', 'main'],
      conditions: ['deno', 'import', 'default'],
      target: 'esnext',
      tsconfigRaw: {},
      logLevel: 'silent',
      metafile: true,
      plugins: [manifestBundleBoundary(canonicalRoot, options.kind, reader)],
    });
    if (
      Object.values(bundled.metafile.outputs).some(
        (output) => output.imports.length,
      )
    )
      throw new Error('Manifest bundle must not contain external imports.');
    await invoke(['check', ...flags, file]);
    const source = bundled.outputFiles[0]?.text;
    if (!source) throw new Error('Manifest bundle is empty.');
    const evaluated = await invoke(
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--no-prompt',
        '-',
      ],
      {
        input: `${SERIALIZER}\n${source}\n`,
        timeoutMs: options.evaluationTimeoutMs ?? 30_000,
      },
    );
    const records = evaluated.stdout
      .split('\n')
      .filter((line) => line.startsWith(RESULT));
    if (records.length !== 1)
      throw new Error('Manifest evaluation must emit exactly one result.');
    return {
      file,
      manifest: options.parse(JSON.parse(records[0].slice(RESULT.length))),
    };
  } catch (error) {
    throw new Error(
      `${file} validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
