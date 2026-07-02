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
    filter: (src) => path.basename(src) !== '.git',
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

    // 2) Install app-declared npm dependencies. A `package.json` lets the app
    // bring its own packages (frontend bundle + Deno backend). We force
    // `--node-modules-dir=auto` so a local node_modules is always materialized
    // for esbuild, even when the app keeps a `deno.json` with
    // `nodeModulesDir: "none"` (which `deno install` would otherwise honor and
    // skip node_modules). The install also primes Deno's module cache +
    // deno.lock, used by the backend at runtime with --node-modules-dir=none,
    // so the heavy node_modules is never staged. Legacy single-file apps have
    // no package.json and keep resolving the bundle's imports from the
    // platform's node_modules.
    //
    // The install runs with a sandboxed env (no platform secrets): Deno does not
    // execute npm lifecycle scripts without an explicit `--allow-scripts`, so no
    // app-controlled code runs here, but we still withhold the platform's
    // secrets as defense-in-depth. `--lock=deno.lock` forces a lockfile even when
    // the app's deno.json sets `"lock": false`, so the staged artifact always
    // pins exact versions (the runtime enforces this lock).
    const hasPackageJson = await pathExists(path.join(src, 'package.json'));
    if (hasPackageJson) {
      const install = await run(
        'deno',
        ['install', '--node-modules-dir=auto', '--lock=deno.lock'],
        {
          cwd: src,
          env: subprocessSandboxEnv(),
        },
      );
      logs.push(
        `$ deno install --node-modules-dir=auto --lock=deno.lock\n${install.output.trim()}`,
      );
      if (install.code !== 0) {
        throw new Error(`Dependency install failed:\n${install.output}`);
      }
    }
    // esbuild resolves bare imports by walking node_modules up from each entry
    // file, then falling back to `nodePaths`. package.json apps get their own
    // node_modules (from `deno install`) preferred via the in-src entry walk; the
    // platform node_modules stays a fallback so an app that adds a package.json
    // for one dependency doesn't have to re-declare react/connect/etc. Legacy
    // single-file apps have no app node_modules, so they resolve straight from
    // the platform via nodePaths (the temp build dir lives outside the repo, so
    // esbuild's directory walk can't reach platform deps otherwise).
    const esbuildResolve = {
      absWorkingDir: hasPackageJson ? src : REPO_ROOT,
      nodePaths: [path.join(REPO_ROOT, 'node_modules')],
    };

    const define = browserDefine(id, manifest.name);

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

    // 5) Stage the Deno backend + generated stubs + dependency manifest for the
    // runtime. We stage package.json + deno.lock (not node_modules): the backend
    // runs with --node-modules-dir=none and resolves deps from Deno's module
    // cache (primed by `deno install` above). A legacy deno.json import map is
    // staged when present so single-file apps keep working.
    if (manifest.capabilities.backend && manifest.backend) {
      // Pre-cache the backend's full module graph into Deno's global cache so a
      // healthy backend never resolves deps from the network at startup, and bad
      // deps fail the deploy instead of the first request. `--node-modules-dir=
      // none` mirrors the runtime flag so the cache is primed for the exact
      // resolution mode used there; `--lock=deno.lock` completes/pins the lock
      // (covering any backend imports beyond package.json) even under
      // `"lock": false`. Cache exactly the declared entry the runtime runs.
      const backendEntry = manifest.backend.entry;
      const cache = await run(
        'deno',
        ['cache', '--node-modules-dir=none', '--lock=deno.lock', backendEntry],
        { cwd: src, env: subprocessSandboxEnv() },
      );
      logs.push(
        `$ deno cache --node-modules-dir=none --lock=deno.lock ${backendEntry}\n${cache.output.trim()}`,
      );
      if (cache.code !== 0) {
        throw new Error(`Backend dependency cache failed:\n${cache.output}`);
      }
      // The manifest schema constrains `backend.entry` to live under `backend/`,
      // so staging these two trees always includes the declared entry + stubs.
      for (const dir of ['backend', 'gen']) {
        const from = path.join(src, dir);
        if (await pathExists(from)) {
          await fs.cp(from, path.join(out, dir), { recursive: true });
        }
      }
      for (const file of ['package.json', 'deno.lock', 'deno.json']) {
        const from = path.join(src, file);
        if (await pathExists(from)) {
          await fs.copyFile(from, path.join(out, file));
        }
      }
      logs.push('staged Deno backend');
    }

    const normalized = normalizeManifest(manifest);
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
