/** Build self-contained SDK payloads from public runtime and type entrypoints. */
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';
import {
  SDK_DEFINITIONS,
  type SdkDefinition,
} from '../sdk-internal/definitions';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdkRoot = path.join(root, 'sdk-internal');
const temporary = await mkdtemp(path.join(sdkRoot, '.build-'));
const declarations = path.join(temporary, 'declarations');
const payloads = path.join(temporary, 'payloads');
let preserveTemporary = false;

/** Deno resolves declaration imports literally; there are no JS files in _types. */
function denoDeclarations(source: string): string {
  const scanner = createScanner(true, undefined, source);
  let previous = SyntaxKind.Unknown;
  let beforePrevious = SyntaxKind.Unknown;
  const replacements: { start: number; end: number; value: string }[] = [];
  for (
    let token = scanner.scan();
    token !== SyntaxKind.EndOfFile;
    token = scanner.scan()
  ) {
    if (
      token === SyntaxKind.StringLiteral &&
      (previous === SyntaxKind.FromKeyword ||
        previous === SyntaxKind.ImportKeyword ||
        (previous === SyntaxKind.OpenParenToken &&
          beforePrevious === SyntaxKind.ImportKeyword))
    ) {
      const value = scanner.getTokenValue();
      if (value.startsWith('.') && value.endsWith('.js'))
        replacements.push({
          start: scanner.getTokenStart(),
          end: scanner.getTokenEnd(),
          value: JSON.stringify(value.replace(/\.js$/, '.d.ts')),
        });
    }
    beforePrevious = previous;
    previous = token;
  }
  for (const replacement of replacements.reverse()) {
    source =
      source.slice(0, replacement.start) +
      replacement.value +
      source.slice(replacement.end);
  }
  return source;
}

function inside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function relativeImport(from: string, to: string): string {
  const relative = path
    .relative(path.dirname(from), to)
    .split(path.sep)
    .join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function exportedPath(directory: string, entry: string): string {
  const resolved = path.resolve(directory, entry);
  if (
    !entry.startsWith('./dist/') ||
    !inside(path.join(directory, 'dist'), resolved)
  ) {
    throw new Error(`SDK export must stay in dist: ${entry}`);
  }
  return resolved;
}

function assertPeer(specifier: string, definition: SdkDefinition): void {
  if (
    !Object.keys(definition.manifest.peerDependencies).some(
      (peer) => specifier === peer || specifier.startsWith(`${peer}/`),
    )
  )
    throw new Error(
      `Undeclared SDK dependency in ${definition.manifest.name}: ${specifier}`,
    );
}

const exec = promisify(execFile);
const tsc = fileURLToPath(
  new URL('./bin/tsc', import.meta.resolve('typescript/package.json')),
);

async function compiler(args: string[]): Promise<string> {
  const result = await exec(process.execPath, [tsc, ...args], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function emitDeclarations(): Promise<void> {
  await compiler([
    '-p',
    path.join(sdkRoot, 'tsconfig.json'),
    '--outDir',
    declarations,
    '--noEmitOnError',
  ]);
}

async function buildDefinition(definition: SdkDefinition): Promise<void> {
  const directory = path.join(payloads, definition.directory);
  const dist = path.join(directory, 'dist');
  await mkdir(dist, { recursive: true });
  const { manifest, entries } = definition;
  if (
    Object.keys(entries).sort().join() !==
    Object.keys(manifest.exports).sort().join()
  ) {
    throw new Error(`SDK sources and exports differ: ${manifest.name}`);
  }

  const entryPoints: { in: string; out: string }[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const output = manifest.exports[key];
    exportedPath(directory, output.default);
    exportedPath(directory, output.types);
    if ('source' in entry)
      entryPoints.push({
        in: path.join(sdkRoot, definition.directory, 'src', entry.source),
        out: output.default.slice('./dist/'.length).replace(/\.js$/, ''),
      });
  }
  if (entryPoints.length) {
    const result = await build({
      absWorkingDir: root,
      entryPoints,
      outdir: dist,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      packages: 'external',
      chunkNames: 'chunks/[name]-[hash]',
      metafile: true,
      logLevel: 'silent',
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        if (dependency.external) assertPeer(dependency.path, definition);
        else if (!inside(dist, path.resolve(root, dependency.path))) {
          throw new Error(`Runtime dependency escapes SDK: ${dependency.path}`);
        }
      }
    }
  }

  // Ask the same compiler that emitted these declarations for their complete
  // type dependency graph, including import types and triple-slash references.
  // This avoids a second parser or hand-maintained declaration file allowlist.
  if (entryPoints.length) {
    const config = path.join(temporary, `${definition.directory}-types.json`);
    const files = entryPoints.map((entry) =>
      path.join(
        declarations,
        path.relative(root, entry.in).replace(/\.ts$/, '.d.ts'),
      ),
    );
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: [],
          noEmit: true,
          skipLibCheck: false,
        },
        files,
      }),
    );
    await compiler(['-p', config]);
    const graph = await compiler(['-p', config, '--listFilesOnly']);
    for (const file of graph.trim().split(/\r?\n/)) {
      if (!inside(declarations, file)) {
        if (!inside(path.join(root, 'node_modules'), file)) {
          throw new Error(
            `Declaration dependency escapes build inputs: ${file}`,
          );
        }
        continue;
      }
      const target = path.join(
        dist,
        '_types',
        path.relative(declarations, file),
      );
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, denoDeclarations(await readFile(file, 'utf8')));
    }
  }

  for (const [key, entry] of Object.entries(entries)) {
    const output = manifest.exports[key];
    const js = exportedPath(directory, output.default);
    const dts = exportedPath(directory, output.types);
    await mkdir(path.dirname(js), { recursive: true });
    await mkdir(path.dirname(dts), { recursive: true });
    let source: string;
    if ('source' in entry) {
      const emitted = path.join(
        declarations,
        'sdk-internal',
        definition.directory,
        'src',
        entry.source.replace(/\.ts$/, '.d.ts'),
      );
      const target = path.join(
        dist,
        '_types',
        path.relative(declarations, emitted),
      );
      await access(target);
      await writeFile(
        dts,
        `export * from ${JSON.stringify(relativeImport(dts, target))};\n`,
      );
      source = await readFile(js, 'utf8');
    } else {
      const target = SDK_DEFINITIONS.flatMap((sdk) =>
        Object.entries(sdk.manifest.exports).map(([subpath, value]) => ({
          specifier:
            subpath === '.'
              ? sdk.manifest.name
              : sdk.manifest.name + subpath.slice(1),
          file: exportedPath(path.join(payloads, sdk.directory), value.default),
        })),
      ).find((candidate) => candidate.specifier === entry.reexport);
      if (!target) throw new Error(`Unknown SDK re-export: ${entry.reexport}`);
      source = `export * from ${JSON.stringify(relativeImport(js, target.file))};\n`;
      await writeFile(
        dts,
        `export * from ${JSON.stringify(relativeImport(dts, target.file).replace(/\.js$/, '.d.ts'))};\n`,
      );
    }
    await writeFile(
      js,
      `// @ts-self-types=${JSON.stringify(relativeImport(js, dts))}\n${source}`,
    );
  }
  await cp(
    path.join(sdkRoot, definition.directory, 'package.json'),
    path.join(directory, 'package.json'),
  );
}

/** Publish only after every payload succeeds, restoring all previous dist trees on failure. */
async function publish(): Promise<void> {
  const installed: {
    destination: string;
    backup: string;
    hadPrevious: boolean;
  }[] = [];
  try {
    for (const definition of SDK_DEFINITIONS) {
      const destination = path.join(sdkRoot, definition.directory, 'dist');
      const backup = path.join(temporary, `previous-${definition.directory}`);
      const hadPrevious = await access(destination).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (hadPrevious) await rename(destination, backup);
      installed.push({ destination, backup, hadPrevious });
      await rename(
        path.join(payloads, definition.directory, 'dist'),
        destination,
      );
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const entry of installed.reverse()) {
      try {
        await rm(entry.destination, { recursive: true, force: true });
        if (entry.hadPrevious) await rename(entry.backup, entry.destination);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length) {
      preserveTemporary = true;
      throw new AggregateError(
        [error, ...failures],
        `SDK build recovery failed; backups retained at ${temporary}`,
      );
    }
    throw error;
  }
}

try {
  await emitDeclarations();
  for (const definition of SDK_DEFINITIONS) await buildDefinition(definition);
  await publish();
  console.log(
    'Built @hatch/app, @hatch/workflow and legacy @hatch/data re-exports.',
  );
} finally {
  if (!preserveTemporary) await rm(temporary, { recursive: true, force: true });
}
