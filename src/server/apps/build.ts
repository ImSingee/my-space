/** Server-only: compile an app source tree into deployable artifacts. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import {
  BUILD_WORK_DIR,
  REPO_ROOT,
  appBuildDir,
  appSrcDir,
} from '~agent/paths';
import {
  type AppApi,
  type NormalizedManifest,
  type ProtoFile,
  type RpcServiceApi,
  type SourceManifest,
  normalizeManifest,
  parseSourceManifest,
  rpcUrl,
} from './manifest';
import { subprocessSandboxEnv } from '../sandbox-env';
import { validateDenoDependencySource } from '../deno-dependencies';
import { run as runSubprocess } from '../subprocess';

export type BuildResult = {
  source: SourceManifest;
  normalized: NormalizedManifest;
  log: string;
};

export type BuildAppOptions = {
  sourceDir?: string;
  outputDir?: string;
};

const BIN_DIR = path.join(REPO_ROOT, 'node_modules', '.bin');

/**
 * The only codegen config `buf generate` ever runs with. App sources carry a
 * copy for local iteration, but the build overwrites it (see below) because
 * buf `local:` plugins are arbitrary commands. Must mirror the scaffold
 * template so agent-side and platform-side codegen agree.
 */
const PLATFORM_BUF_GEN_YAML = `version: v2
clean: true
plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
      - import_extension=none
`;

/**
 * Bounded build-step runner (shared timeout + output cap) with the platform's
 * node_modules/.bin prepended so buf can resolve the protoc-gen-es plugin.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; output: string }> {
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
function browserDefine(id: string, name: string): Record<string, string> {
  return {
    __RPC_BASE_URL__: JSON.stringify(rpcUrl(id)),
    __APP_NAME__: JSON.stringify(name),
    'process.env.NODE_ENV': '"production"',
  };
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
  await fs.cp(originalSrc, tempSrc, {
    recursive: true,
    // Reproduce dependencies from the committed lock below; never trust or
    // waste time copying a source checkout's pre-existing installations. The
    // fixed assets directory is copied byte-for-byte later, so names that have
    // build meaning elsewhere remain ordinary resource names inside it.
    filter: (source) => {
      const relative = path
        .relative(originalSrc, source)
        .split(path.sep)
        .join('/');
      if (
        relative === 'backend/assets' ||
        relative.startsWith('backend/assets/')
      ) {
        return true;
      }
      return !['.git', 'node_modules'].includes(path.basename(source));
    },
  });

  const src = tempSrc;

  try {
    const manifest = await readManifest(src);

    // The manifest id drives every generated URL (app/widget/RPC/storage), but
    // artifacts and the DB row are keyed by the `id` argument. If they diverge,
    // the deploy "succeeds" with URLs pointing at a different slug. Reject early.
    if (manifest.id !== id) {
      throw new Error(
        `manifest.id "${manifest.id}" does not match the app id "${id}". ` +
          'Fix manifest.json so its id matches the app.',
      );
    }

    await validateDenoDependencySource(src, 'app');

    // Fresh output directory.
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });

    // 1) Connect codegen from proto (if the app has a backend RPC service). We
    // also compile the proto to a descriptor set so the platform records the
    // app's declared API (services + methods) and uploads the raw proto.
    const protoPath = manifest.rpc ? path.join(src, manifest.rpc.proto) : null;
    let api: AppApi | undefined;
    if (manifest.rpc && protoPath && (await pathExists(protoPath))) {
      // `buf generate` executes the plugins listed in buf.gen.yaml, and `local:`
      // plugins are arbitrary commands. The file ships with the app source, so
      // an app could point it at `sh` and run code at build time. Overwrite it
      // (we build from a temp copy) with the platform's fixed codegen config so
      // only the sanctioned plugin ever runs, and withhold platform secrets
      // from the plugin's environment like every other build subprocess.
      await fs.writeFile(path.join(src, 'buf.gen.yaml'), PLATFORM_BUF_GEN_YAML);
      const gen = await run('buf', ['generate'], {
        cwd: src,
        env: subprocessSandboxEnv(),
      });
      logs.push(`$ buf generate\n${gen.output.trim()}`);
      if (gen.code !== 0) {
        throw new Error(`Connect codegen failed:\n${gen.output}`);
      }
      api = await extractAppApi(src);
      logs.push(
        `captured app API: ${api.services.length} service(s), ${api.protoFiles.length} proto file(s)`,
      );
    }

    // 2) Reproduce the Agent-reviewed dependency install from the committed
    // package.json + deno.json + deno.lock. `--frozen` makes deploy validation
    // read-only: dependency edits must be installed and committed by the Agent
    // before deploy. Deno reads reviewed allowScripts entries from deno.json.
    const installArgs = [
      'install',
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
    // esbuild resolves bare imports by walking node_modules up from each entry
    // file, then falling back to `nodePaths`. The app's node_modules from Deno
    // takes precedence; platform packages remain a fallback for dependencies
    // supplied by the scaffold/runtime.
    const esbuildResolve = {
      absWorkingDir: src,
      nodePaths: [path.join(REPO_ROOT, 'node_modules')],
    };

    const define = browserDefine(id, manifest.name);
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

    // 4b) Bundle each userscript -> a single self-contained browser IIFE. The
    // request-time route prepends the Tampermonkey metadata block, so here we
    // only emit the executable body. IIFE (not ESM) because Tampermonkey injects
    // a classic script — top-level `import`/`export` would not run — while GM_*
    // grants stay reachable as globals inside the IIFE.
    if (manifest.capabilities.userscripts && manifest.userscripts.length > 0) {
      await fs.mkdir(path.join(out, 'userscripts'), { recursive: true });
      for (const script of manifest.userscripts) {
        const entry = path.join(src, script.entry);
        if (!(await pathExists(entry))) {
          throw new Error(`userscript entry not found: ${script.entry}`);
        }
        await esbuild.build({
          ...esbuildResolve,
          entryPoints: [entry],
          outfile: path.join(out, 'userscripts', `${script.id}.js`),
          bundle: true,
          format: 'iife',
          platform: 'browser',
          target: 'es2022',
          jsx: 'automatic',
          minify: true,
          sourcemap: false,
          define,
          logLevel: 'silent',
        });
        logs.push(
          `bundled userscript ${script.id} -> userscripts/${script.id}.js`,
        );
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
        '--platform=deno',
        '--packages=bundle',
        '--node-modules-dir=auto',
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

    return { source: manifest, normalized, log: logs.join('\n') };
  } finally {
    await fs.rm(tempSrc, { recursive: true, force: true });
  }
}
