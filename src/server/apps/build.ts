/** Server-only: compile an app source tree into deployable artifacts. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import {
  BUILD_WORK_DIR,
  REPO_ROOT,
  appBuildDir,
  appSrcDir,
} from '~agent/paths';
import {
  appHatchDataPackageDir,
  appHatchImportMapPath,
  materializeAppHatchSdk,
} from '~agent/hatch-sdk';
import { PLATFORM_APP_BUF_GEN_YAML } from '~agent/app-codegen';
import {
  type AppApi,
  type NormalizedManifest,
  type ProtoFile,
  type RpcServiceApi,
  type SourceManifest,
  dataTableUrl,
  normalizeManifest,
  parseSourceManifest,
  rpcUrl,
} from './manifest';
import {
  parseDataSchemaDescriptor,
  type DataSchemaDescriptor,
} from './data-table/schema';
import { subprocessSandboxEnv } from '../sandbox-env';
import { validateDenoDependencySource } from '../deno-dependencies';
import { run as runSubprocess } from '../subprocess';

export type BuildResult = {
  source: SourceManifest;
  normalized: NormalizedManifest;
  dataSchema?: DataSchemaDescriptor;
  log: string;
};

export type BuildAppOptions = {
  sourceDir?: string;
  outputDir?: string;
  deploymentId?: string;
};

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');

/**
 * Bounded build-step runner (shared timeout + output cap) with the platform's
 * node_modules/.bin prepended so buf can resolve the protoc-gen-es plugin.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): ReturnType<typeof runSubprocess> {
  const baseEnv = opts.env ?? process.env;
  return runSubprocess(cmd, args, {
    cwd: opts.cwd,
    env: { ...baseEnv, PATH: `${BIN_DIR}:${baseEnv.PATH ?? ''}` },
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function backendBundleEntry(sourceEntry: string): string {
  const normalized = sourceEntry.replaceAll('\\', '/');
  const extension = path.posix.extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  return `${stem}.bundle.js`;
}

async function copyBackendAssetNode(
  source: string,
  destination: string,
  relativePath: string,
): Promise<void> {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(`backend asset disappeared during build: ${relativePath}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) {
      await copyBackendAssetNode(
        path.join(source, entry),
        path.join(destination, entry),
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend asset must be a regular file or directory: ${relativePath}`,
    );
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyBackendAssets(
  sourceRoot: string,
  outputRoot: string,
): Promise<void> {
  const backendPath = 'backend';
  const backendSource = path.join(sourceRoot, backendPath);
  const backendStat = await fs.lstat(backendSource).catch(() => null);
  if (backendStat?.isSymbolicLink()) {
    throw new Error(
      `backend source directory must not be a symbolic link: ${backendPath}`,
    );
  }
  if (backendStat && !backendStat.isDirectory()) {
    throw new Error(`backend source path must be a directory: ${backendPath}`);
  }

  const relativePath = 'backend/assets';
  const source = path.join(sourceRoot, relativePath);
  const destination = path.join(outputRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);

  // The runtime contract always points at this directory, including for apps
  // that do not ship static files.
  await fs.mkdir(destination, { recursive: true });
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new Error(
      `backend asset directory must not be a symbolic link: ${relativePath}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`backend asset path must be a directory: ${relativePath}`);
  }
  for (const entry of await fs.readdir(source)) {
    await copyBackendAssetNode(
      path.join(source, entry),
      path.join(destination, entry),
      path.posix.join(relativePath, entry),
    );
  }
}

async function validateBackendBundleSourceNode(
  sourceRoot: string,
  relativePath: string,
): Promise<void> {
  // Assets have their own stricter copy-time walk and diagnostics below.
  if (
    relativePath === 'backend/assets' ||
    relativePath.startsWith('backend/assets/')
  ) {
    return;
  }

  const source = path.join(sourceRoot, relativePath);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat) {
    throw new Error(
      `backend bundle source disappeared during build: ${relativePath}`,
    );
  }
  if (stat.isSymbolicLink()) {
    if (relativePath === 'backend') {
      throw new Error(
        'backend source directory must not be a symbolic link: backend',
      );
    }
    throw new Error(
      `backend bundle source must not be a symbolic link: ${relativePath}`,
    );
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(source)) {
      await validateBackendBundleSourceNode(
        sourceRoot,
        path.posix.join(relativePath, entry),
      );
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `backend bundle source must be a regular file or directory: ${relativePath}`,
    );
  }
}

async function validateBackendBundleSourceTree(
  sourceRoot: string,
): Promise<void> {
  // Check the platform-defined backend/generated roots. Installed packages
  // legitimately contain package-manager links, and unrelated app content
  // should not be rejected merely because the app also has a backend.
  for (const root of ['backend', 'gen']) {
    const stat = await fs.lstat(path.join(sourceRoot, root)).catch(() => null);
    if (stat) await validateBackendBundleSourceNode(sourceRoot, root);
  }
}

/**
 * Source trees are untrusted. The builder overwrites platform-managed files and
 * invokes tools inside its temporary copy, so even one preserved symlink could
 * redirect a write/read outside that copy. Validate the copied tree before the
 * first manifest read or generated-file write and never recurse through links.
 */
async function assertSourceHasNoSymlinks(root: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error('App source may not contain symbolic links: .');
  }

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if (relative === 'backend') {
          throw new Error(
            'backend source directory must not be a symbolic link: backend',
          );
        }
        if (relative === 'backend/assets') {
          throw new Error(
            'backend asset directory must not be a symbolic link: backend/assets',
          );
        }
        if (relative.startsWith('backend/assets/')) {
          throw new Error(
            `backend asset must not be a symbolic link: ${relative}`,
          );
        }
        if (
          relative.startsWith('backend/') ||
          relative === 'gen' ||
          relative.startsWith('gen/')
        ) {
          throw new Error(
            `backend bundle source must not be a symbolic link: ${relative}`,
          );
        }
        throw new Error(
          `App source may not contain symbolic links: ${relative}`,
        );
      }
      if (entry.isDirectory()) await walk(full);
    }
  }

  await walk(root);
}

async function readManifest(src: string): Promise<SourceManifest> {
  const raw = await fs.readFile(path.join(src, 'manifest.json'), 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `manifest.json is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  return parseSourceManifest(json);
}

type SourceCheckEntry = {
  path: string;
  missingMessage: string;
};

/**
 * Return the authored TypeScript roots enabled by the source manifest. Deno
 * follows every transitive import from these roots, so one invocation checks
 * the complete App graph while avoiding disabled capabilities.
 */
function sourceCheckEntries(manifest: SourceManifest): SourceCheckEntry[] {
  const entries: SourceCheckEntry[] = [];
  if (manifest.capabilities.frontend && manifest.app) {
    entries.push({
      path: manifest.app.entry,
      missingMessage: `app entry not found: ${manifest.app.entry}`,
    });
  }
  if (manifest.capabilities.backend && manifest.backend) {
    entries.push({
      path: manifest.backend.entry,
      missingMessage: `backend entry not found: ${manifest.backend.entry}`,
    });
  }
  if (manifest.capabilities.widgets) {
    for (const widget of manifest.widgets) {
      entries.push({
        path: widget.entry,
        missingMessage: `widget entry not found: ${widget.entry}`,
      });
    }
  }
  if (manifest.capabilities.dataTable) {
    entries.push({
      path: 'data/schema.ts',
      missingMessage:
        'capabilities.dataTable is true but data/schema.ts does not exist.',
    });
  }

  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

/** Type-check every enabled App entry before evaluating or bundling source. */
async function checkAppSource(
  src: string,
  manifest: SourceManifest,
  logs: string[],
): Promise<void> {
  const entries = sourceCheckEntries(manifest);
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (!(await pathExists(path.join(src, entry.path)))) {
      throw new Error(`Source validation failed: ${entry.missingMessage}`);
    }
  }

  const checkArgs = [
    'check',
    '--config=deno.json',
    '--no-remote',
    '--node-modules-dir=auto',
    `--import-map=${appHatchImportMapPath(src)}`,
    '--lock=deno.lock',
    '--frozen',
    '--',
    ...entries.map((entry) => entry.path),
  ];
  const checked = await run('deno', checkArgs, {
    cwd: src,
    env: subprocessSandboxEnv(),
  });
  logs.push(`$ deno ${checkArgs.join(' ')}\n${checked.output.trim()}`);
  if (checked.code !== 0) {
    throw new Error(
      `Source validation failed during deno check:\n${checked.output}`,
    );
  }
}

/**
 * Minimal shape of a protoc/buf JSON `FileDescriptorSet`. proto3 JSON omits
 * fields at their default value, so streaming flags are optional (absent =
 * false) and type references carry a leading dot we strip when displaying.
 */
type DescriptorMethod = {
  name?: string;
  inputType?: string;
  outputType?: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
};
type DescriptorService = { name?: string; method?: DescriptorMethod[] };
type DescriptorFile = {
  name?: string;
  package?: string;
  service?: DescriptorService[];
};
type FileDescriptorSet = { file?: DescriptorFile[] };

function stripLeadingDot(t: string): string {
  return t.startsWith('.') ? t.slice(1) : t;
}

/** Map a compiled descriptor set to the platform's service/method API view. */
function parseServices(set: FileDescriptorSet): RpcServiceApi[] {
  const services: RpcServiceApi[] = [];
  for (const file of set.file ?? []) {
    const pkg = file.package ? `${file.package}.` : '';
    for (const svc of file.service ?? []) {
      if (!svc.name) continue;
      services.push({
        name: `${pkg}${svc.name}`,
        methods: (svc.method ?? []).map((m) => ({
          name: m.name ?? '',
          inputType: stripLeadingDot(m.inputType ?? ''),
          outputType: stripLeadingDot(m.outputType ?? ''),
          clientStreaming: m.clientStreaming ?? false,
          serverStreaming: m.serverStreaming ?? false,
        })),
      });
    }
  }
  return services;
}

/** Recursively read every `.proto` under the app's fixed `proto/` directory. */
async function collectProtoFiles(src: string): Promise<ProtoFile[]> {
  const protoRoot = path.join(src, 'proto');
  if (!(await pathExists(protoRoot))) return [];
  const files: ProtoFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.proto')) {
        files.push({
          path: path.relative(src, full).split(path.sep).join('/'),
          content: await fs.readFile(full, 'utf8'),
        });
      }
    }
  }
  await walk(protoRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Capture the app's declared API: compile the proto module to a JSON descriptor
 * set (so we enumerate services + methods exactly as the wire sees them) and
 * collect the raw proto sources for upload. Runs alongside `buf generate` and is
 * keyed off the same `proto/` module.
 */
async function extractAppApi(src: string): Promise<AppApi> {
  // Write to a temp file (not stdout) so buf warnings on stderr never corrupt
  // the JSON we parse. The file lives outside the staged output dir.
  const descriptorPath = path.join(
    BUILD_WORK_DIR,
    `descriptor-${randomUUID()}.json`,
  );
  await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
  try {
    const built = await run('buf', ['build', '-o', descriptorPath], {
      cwd: src,
      env: subprocessSandboxEnv(),
    });
    if (built.code !== 0) {
      throw new Error(`buf build (API descriptor) failed:\n${built.output}`);
    }
    const set = JSON.parse(
      await fs.readFile(descriptorPath, 'utf8'),
    ) as FileDescriptorSet;
    return {
      services: parseServices(set),
      protoFiles: await collectProtoFiles(src),
    };
  } finally {
    await fs.rm(descriptorPath, { force: true });
  }
}

/** Shared esbuild define for browser bundles (app + widgets). */
function browserDefine(
  id: string,
  name: string,
  deploymentId: string | undefined,
): Record<string, string> {
  return {
    __RPC_BASE_URL__: JSON.stringify(rpcUrl(id)),
    __DATA_BASE_URL__: JSON.stringify(dataTableUrl(id)),
    __DATA_DEPLOYMENT_ID__: JSON.stringify(deploymentId ?? ''),
    __APP_NAME__: JSON.stringify(name),
    'process.env.NODE_ENV': '"production"',
  };
}

/** Resolve only the public, platform-owned Hatch SDK browser entrypoints. */
function hatchSdkPlugin(src: string): esbuild.Plugin {
  const sdk = appHatchDataPackageDir(src);
  const entries = new Map([
    ['@hatch/data', path.join(sdk, 'dist', 'data.js')],
    ['@hatch/data/react', path.join(sdk, 'dist', 'data-react.js')],
  ]);
  return {
    name: 'hatch-sdk',
    setup(build) {
      build.onResolve({ filter: /^@hatch(?:\/|$)/ }, (args) => {
        const resolved = entries.get(args.path);
        if (resolved) return { path: resolved };
        return {
          errors: [
            {
              text:
                `Unknown Hatch SDK import "${args.path}". ` +
                'Use @hatch/data or @hatch/data/react.',
            },
          ],
        };
      });
    },
  };
}

function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function browserLoaderForPath(target: string): esbuild.Loader | undefined {
  switch (path.extname(target).toLowerCase()) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.json':
      return 'json';
    case '.css':
      return 'css';
    case '.txt':
      return 'text';
    default:
      return undefined;
  }
}

function directBrowserLocalPath(
  specifier: string,
  resolveDir: string,
): { path: string; suffix?: string } | null {
  if (specifier.startsWith('file:')) {
    let url: URL;
    try {
      url = new URL(specifier);
      if (url.protocol !== 'file:') return null;
      const suffix = `${url.search}${url.hash}` || undefined;
      url.search = '';
      url.hash = '';
      return { path: fileURLToPath(url), suffix };
    } catch {
      return { path: specifier };
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('\\\\')) {
    return { path: specifier };
  }
  if (path.isAbsolute(specifier)) return { path: specifier };
  if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    return { path: path.resolve(resolveDir, specifier) };
  }
  return null;
}

/**
 * Defense in depth for esbuild's separate resolver. Every browser module is
 * canonicalized before its bytes are returned to esbuild, including package
 * files reached through node_modules links. Installed dependencies and the
 * managed .hatch SDK remain valid because both live below the temporary source
 * root; platform-repository fallback modules do not.
 */
function browserSourceBoundaryPlugin(sourceRoot: string): esbuild.Plugin {
  return {
    name: 'app-source-boundary',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const local = directBrowserLocalPath(args.path, args.resolveDir);
        if (!local) return undefined;
        const absolute = path.resolve(local.path);
        if (!pathIsInside(sourceRoot, absolute)) {
          return {
            errors: [
              {
                text:
                  `Browser import "${args.path}" must stay inside the App ` +
                  'source root.',
              },
            ],
          };
        }
        // esbuild does not resolve file: URLs itself. Other local forms can use
        // its normal extension/package metadata handling before onLoad applies
        // the canonical check below.
        if (args.path.startsWith('file:')) return local;
        return undefined;
      });

      build.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        let canonical: string;
        try {
          canonical = await fs.realpath(args.path);
        } catch (error) {
          return {
            errors: [
              {
                text:
                  `Browser module "${args.path}" could not be verified: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
        if (!pathIsInside(sourceRoot, canonical)) {
          return {
            errors: [
              {
                text:
                  `Browser module "${args.path}" resolves outside the App ` +
                  'source root.',
              },
            ],
          };
        }

        const loader = browserLoaderForPath(canonical);
        if (!loader) return undefined;
        let handle;
        try {
          handle = await fs.open(
            canonical,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
          if (!(await handle.stat()).isFile()) {
            return {
              errors: [
                { text: `Browser module is not a regular file: ${args.path}` },
              ],
            };
          }
          return {
            contents: await handle.readFile(),
            loader,
            resolveDir: path.dirname(canonical),
          };
        } catch (error) {
          return {
            errors: [
              {
                text:
                  `Browser module "${args.path}" could not be read safely: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        } finally {
          await handle?.close();
        }
      });
    },
  };
}

const DATA_SCHEMA_SENTINEL = '[[hatch-data-schema]]';

async function describeDataSchema(
  src: string,
  logs: string[],
): Promise<DataSchemaDescriptor> {
  const schemaPath = path.join(src, 'data', 'schema.ts');
  if (!(await pathExists(schemaPath))) {
    throw new Error(
      'capabilities.dataTable is true but data/schema.ts does not exist.',
    );
  }
  const runner = path.join(src, '.hatch', '__describe_data.ts');
  await fs.writeFile(
    runner,
    `import schema from '../data/schema.ts';\n` +
      `console.log(${JSON.stringify(DATA_SCHEMA_SENTINEL)} + JSON.stringify(schema.descriptor));\n`,
    'utf8',
  );
  const describeArgs = [
    'run',
    '--no-prompt',
    '--config=deno.json',
    '--no-remote',
    '--node-modules-dir=auto',
    `--import-map=${appHatchImportMapPath(src)}`,
    '--lock=deno.lock',
    '--frozen',
    `--allow-read=${src}`,
    runner,
  ];
  const result = await run('deno', describeArgs, {
    cwd: src,
    env: subprocessSandboxEnv(),
  });
  logs.push(`$ deno ${describeArgs.join(' ')}\n${result.output.trim()}`);
  if (result.code !== 0) {
    throw new Error(`Data Table schema evaluation failed:\n${result.output}`);
  }
  const line = result.output
    .split('\n')
    .find((value) => value.startsWith(DATA_SCHEMA_SENTINEL));
  if (!line) {
    throw new Error('Data Table schema did not produce a descriptor.');
  }
  try {
    return parseDataSchemaDescriptor(
      JSON.parse(line.slice(DATA_SCHEMA_SENTINEL.length)),
    );
  } catch (error) {
    throw new Error(
      `Data Table schema is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function buildApp(
  id: string,
  options: BuildAppOptions = {},
): Promise<BuildResult> {
  const originalSrc = options.sourceDir ?? appSrcDir(id);
  const out = options.outputDir ?? appBuildDir(id);
  const logs: string[] = [];

  if (!(await pathExists(originalSrc))) {
    throw new Error(`App source not found: ${originalSrc}`);
  }

  const tempSrc = path.join(BUILD_WORK_DIR, id, randomUUID());
  await fs.rm(tempSrc, { recursive: true, force: true });
  await fs.mkdir(path.dirname(tempSrc), { recursive: true });
  const src = tempSrc;

  try {
    await fs.cp(originalSrc, tempSrc, {
      recursive: true,
      // Reproduce dependencies from the committed lock below; never trust or
      // waste time copying a source checkout's pre-existing installations. The
      // exclusions are platform-generated roots; matching only the first path
      // segment keeps identically named authored directories below app/, widgets/,
      // backend/assets/, and other source trees intact.
      filter: (source) => {
        const relative = path
          .relative(originalSrc, source)
          .split(path.sep)
          .join('/');
        const rootEntry = relative.split('/', 1)[0]?.toLowerCase();
        return !['.git', '.hatch', 'gen', 'node_modules'].includes(rootEntry);
      },
    });
    await assertSourceHasNoSymlinks(tempSrc);

    const manifest = await readManifest(src);

    // The manifest id drives every generated URL (app/widget/RPC), but
    // artifacts and the DB row are keyed by the `id` argument. If they diverge,
    // the deploy "succeeds" with URLs pointing at a different slug. Reject early.
    if (manifest.id !== id) {
      throw new Error(
        `manifest.id "${manifest.id}" does not match the app id "${id}". ` +
          'Fix manifest.json so its id matches the app.',
      );
    }

    await validateDenoDependencySource(src, 'app');

    // Agent worktree dependencies are intentionally absent from deploy bundles.
    // After validating authored dependency metadata, materialize the trusted
    // SDK and fixed platform import map inside this disposable checkout.
    await materializeAppHatchSdk(src);

    // 1) Connect codegen from proto (if the app has a backend RPC service). We
    // also compile the proto to a descriptor set so the platform records the
    // app's declared API (services + methods) and uploads the raw proto.
    const protoPath = manifest.rpc ? path.join(src, manifest.rpc.proto) : null;
    let api: AppApi | undefined;
    if (manifest.rpc && protoPath) {
      const rpc = manifest.rpc;
      const protoEntry = await fs.lstat(protoPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!protoEntry) {
        throw new Error(
          `RPC proto declared by manifest.json was not found: ${rpc.proto}`,
        );
      }
      if (!protoEntry.isFile()) {
        throw new Error(
          `RPC proto declared by manifest.json must be a regular file: ${rpc.proto}`,
        );
      }
      // `buf generate` executes the plugins listed in buf.gen.yaml, and `local:`
      // plugins are arbitrary commands. The file ships with the app source, so
      // an app could point it at `sh` and run code at build time. Overwrite it
      // (we build from a temp copy) with the platform's fixed codegen config so
      // only the sanctioned plugin ever runs, and withhold platform secrets
      // from the plugin's environment like every other build subprocess.
      await fs.writeFile(
        path.join(src, 'buf.gen.yaml'),
        PLATFORM_APP_BUF_GEN_YAML,
      );
      const gen = await run('buf', ['generate'], {
        cwd: src,
        env: subprocessSandboxEnv(),
      });
      logs.push(`$ buf generate\n${gen.output.trim()}`);
      if (gen.code !== 0) {
        throw new Error(`Connect codegen failed:\n${gen.output}`);
      }
      api = await extractAppApi(src);
      if (!api.services.some((service) => service.name === rpc.service)) {
        throw new Error(
          `RPC service declared by manifest.json was not found in the compiled proto: ${rpc.service}`,
        );
      }
      logs.push(
        `captured app API: ${api.services.length} service(s), ${api.protoFiles.length} proto file(s)`,
      );
    }

    // 2) Reproduce the Agent-reviewed dependency install from the committed
    // package.json + deno.lock. `--no-config` prevents Deno from implicitly
    // executing source-controlled lifecycle policy. App deploys never run npm
    // preinstall/install/postinstall code inside the platform process.
    const installArgs = [
      'install',
      '--no-config',
      '--package-json',
      '--node-modules-dir=auto',
      '--lock=deno.lock',
      '--frozen',
    ];
    const install = await run('deno', installArgs, {
      cwd: src,
      env: subprocessSandboxEnv(),
    });
    logs.push(`$ deno ${installArgs.join(' ')}\n${install.output.trim()}`);
    if (install.code !== 0) {
      throw new Error(
        'Dependency install failed with the committed deno.lock. Load the ' +
          '"building-apps" Skill, run deno install locally, commit the updated ' +
          `dependency files, and deploy again:\n${install.output}`,
      );
    }

    // Deno checks every enabled manifest entry and its transitive imports after
    // the frozen install, before schema evaluation, bundling, or artifact writes.
    await checkAppSource(src, manifest, logs);

    // Source checking validates imports and types, but schema.ts still needs to
    // execute to produce the declarative migration descriptor. Keep that run
    // frozen as well so it cannot add an unreviewed dependency to the temporary
    // lockfile and bless it for the rest of this build.
    let dataSchema: DataSchemaDescriptor | undefined;
    if (manifest.capabilities.dataTable) {
      dataSchema = await describeDataSchema(src, logs);
    }

    // Only start replacing the requested output after every source validation
    // step has passed. Deploy builds use a fresh path, while direct callers do
    // not lose a prior output merely because new source fails validation.
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });

    // Browser bundles may resolve only modules materialized inside this build's
    // disposable App root. Deno installed every declared npm dependency above;
    // falling back to the platform repository would make builds non-hermetic.
    const browserSourceRoot = await fs.realpath(src);
    const esbuildResolve = {
      absWorkingDir: src,
      plugins: [
        hatchSdkPlugin(src),
        browserSourceBoundaryPlugin(browserSourceRoot),
      ],
      // Prevent esbuild from walking above the temporary App root in search of
      // a platform tsconfig. Deno remains the source of truth for type checking.
      tsconfigRaw: {
        compilerOptions: {
          jsx: 'react-jsx' as const,
          jsxImportSource: 'react',
        },
      },
    };

    const define = browserDefine(id, manifest.name, options.deploymentId);
    let bundledBackendEntry: string | undefined;

    // 3) Bundle the frontend SPA -> static app/app.js + index.html.
    if (manifest.capabilities.frontend && manifest.app) {
      const entry = path.join(src, manifest.app.entry);
      if (!(await pathExists(entry))) {
        throw new Error(`app entry not found: ${manifest.app.entry}`);
      }
      await fs.mkdir(path.join(out, 'app'), { recursive: true });
      await esbuild.build({
        ...esbuildResolve,
        entryPoints: [entry],
        outfile: path.join(out, 'app', 'app.js'),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        jsx: 'automatic',
        minify: true,
        sourcemap: false,
        define,
        logLevel: 'silent',
      });
      const htmlRel = manifest.app.html ?? 'app/index.html';
      const htmlSrc = path.join(src, htmlRel);
      if (!(await pathExists(htmlSrc))) {
        throw new Error(`app html not found: ${htmlRel}`);
      }
      // Inline the bundle into index.html. The platform serves the app over an
      // extensionless HTML route; inlining avoids a separate .js asset request
      // (which dev middleware would intercept) and keeps the app a single doc.
      const code = await fs.readFile(path.join(out, 'app', 'app.js'), 'utf8');
      const inlined = `<script type="module">${code.replace(
        /<\/script>/g,
        '<\\/script>',
      )}</script>`;
      let html = await fs.readFile(htmlSrc, 'utf8');
      const scriptTag =
        /<script[^>]*src=["']\.?\/?app\.js["'][^>]*>\s*<\/script>/;
      // Use a replacement function so `$`-sequences in the bundle (e.g. React's
      // "$&/") are inserted literally instead of being treated as replacement
      // patterns by String.prototype.replace.
      html = scriptTag.test(html)
        ? html.replace(scriptTag, () => inlined)
        : html.replace('</body>', () => `${inlined}\n</body>`);
      await fs.writeFile(path.join(out, 'app', 'index.html'), html, 'utf8');
      logs.push('bundled app -> inlined into app/index.html');
    }

    // 4) Bundle each widget -> standalone ESM module exporting mount().
    if (manifest.capabilities.widgets && manifest.widgets.length > 0) {
      await fs.mkdir(path.join(out, 'widgets'), { recursive: true });
      for (const widget of manifest.widgets) {
        const entry = path.join(src, widget.entry);
        if (!(await pathExists(entry))) {
          throw new Error(`widget entry not found: ${widget.entry}`);
        }
        await esbuild.build({
          ...esbuildResolve,
          entryPoints: [entry],
          outfile: path.join(out, 'widgets', `${widget.id}.js`),
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          jsx: 'automatic',
          minify: true,
          sourcemap: false,
          define,
          logLevel: 'silent',
        });
        logs.push(`bundled widget ${widget.id} -> widgets/${widget.id}.js`);
      }
    }

    // 5) Bundle the Deno backend, generated stubs, and npm dependencies into one
    // runtime entry. Source files and dependency manifests remain build inputs;
    // only files below the fixed backend/assets directory enter the artifact.
    if (manifest.capabilities.backend && manifest.backend) {
      await copyBackendAssets(src, out);
      await validateBackendBundleSourceTree(src);

      const sourceEntry = manifest.backend.entry;
      bundledBackendEntry = backendBundleEntry(sourceEntry);
      const bundlePath = path.join(out, bundledBackendEntry);
      await fs.mkdir(path.dirname(bundlePath), { recursive: true });
      const bundleArgs = [
        'bundle',
        '--config=deno.json',
        '--no-remote',
        '--platform=deno',
        '--packages=bundle',
        '--node-modules-dir=auto',
        `--import-map=${appHatchImportMapPath(src)}`,
        '--lock=deno.lock',
        '--frozen',
        '-o',
        bundlePath,
        sourceEntry,
      ];
      const bundle = await run('deno', bundleArgs, {
        cwd: src,
        env: subprocessSandboxEnv(),
      });
      logs.push(`$ deno ${bundleArgs.join(' ')}\n${bundle.output.trim()}`);
      if (bundle.code !== 0 || !(await pathExists(bundlePath))) {
        throw new Error(`Backend bundle failed:\n${bundle.output}`);
      }

      const checkArgs = [
        'check',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        bundlePath,
      ];
      const checked = await run('deno', checkArgs, {
        cwd: out,
        env: subprocessSandboxEnv(),
      });
      logs.push(`$ deno ${checkArgs.join(' ')}\n${checked.output.trim()}`);
      if (checked.code !== 0) {
        throw new Error(`Backend bundle validation failed:\n${checked.output}`);
      }
      logs.push(`bundled backend -> ${bundledBackendEntry}`);
    }

    const normalized = normalizeManifest(manifest);
    if (bundledBackendEntry && normalized.backend) {
      normalized.backend = {
        entry: bundledBackendEntry,
        format: 'bundle-v1',
      };
    }
    if (api) normalized.api = api;
    await fs.writeFile(
      path.join(out, 'manifest.normalized.json'),
      JSON.stringify(normalized, null, 2),
      'utf8',
    );
    if (options.deploymentId) {
      // Runtime workers use this immutable marker to reject/restart a backend
      // whose process was spawned from a superseded shared build directory.
      await fs.writeFile(
        path.join(out, 'deployment.json'),
        JSON.stringify({ deploymentId: options.deploymentId }, null, 2),
        'utf8',
      );
    }

    return {
      source: manifest,
      normalized,
      dataSchema,
      log: logs.join('\n'),
    };
  } finally {
    await fs.rm(tempSrc, { recursive: true, force: true });
  }
}
