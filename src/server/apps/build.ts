/** Server-only: compile an app source tree into deployable artifacts. */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  type NormalizedManifest,
  type SourceManifest,
  normalizeManifest,
  parseSourceManifest,
  rpcUrl,
} from './manifest';

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

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, PATH: `${BIN_DIR}:${process.env.PATH ?? ''}` },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d.toString()));
    child.stderr.on('data', (d) => (output += d.toString()));
    child.on('error', (err) => {
      output += `\n${cmd} failed to start: ${err.message}`;
      resolve({ code: 1, output });
    });
    child.on('close', (code) => resolve({ code: code ?? 0, output }));
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

    // Fresh output directory.
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });

    // 1) Connect codegen from proto (if the app has a backend RPC service).
    const protoPath = manifest.rpc ? path.join(src, manifest.rpc.proto) : null;
    if (manifest.rpc && protoPath && (await pathExists(protoPath))) {
      const gen = await run('buf', ['generate'], { cwd: src });
      logs.push(`$ buf generate\n${gen.output.trim()}`);
      if (gen.code !== 0) {
        throw new Error(`Connect codegen failed:\n${gen.output}`);
      }
    }

    const define = browserDefine(id, manifest.name);

    // 2) Bundle the frontend SPA -> static app/app.js + index.html.
    if (manifest.capabilities.frontend && manifest.app) {
      const entry = path.join(src, manifest.app.entry);
      if (!(await pathExists(entry))) {
        throw new Error(`app entry not found: ${manifest.app.entry}`);
      }
      await fs.mkdir(path.join(out, 'app'), { recursive: true });
      await esbuild.build({
        absWorkingDir: REPO_ROOT,
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

    // 3) Bundle each widget -> standalone ESM module exporting mount().
    if (manifest.capabilities.widgets && manifest.widgets.length > 0) {
      await fs.mkdir(path.join(out, 'widgets'), { recursive: true });
      for (const widget of manifest.widgets) {
        const entry = path.join(src, widget.entry);
        if (!(await pathExists(entry))) {
          throw new Error(`widget entry not found: ${widget.entry}`);
        }
        await esbuild.build({
          absWorkingDir: REPO_ROOT,
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

    // 4) Stage the Deno backend + generated stubs + import map for the runtime.
    if (manifest.capabilities.backend && manifest.backend) {
      for (const dir of ['backend', 'gen']) {
        const from = path.join(src, dir);
        if (await pathExists(from)) {
          await fs.cp(from, path.join(out, dir), { recursive: true });
        }
      }
      const denoJson = path.join(src, 'deno.json');
      if (await pathExists(denoJson)) {
        await fs.copyFile(denoJson, path.join(out, 'deno.json'));
      }
      logs.push('staged Deno backend');
    }

    const normalized = normalizeManifest(manifest);
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
