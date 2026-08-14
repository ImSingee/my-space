import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { HATCH_SDK_IMPORT_MAP } from '~agent/hatch-sdk';
import { buildApp } from './build';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

async function makeAppSource(
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<{ sourceDir: string; outputDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-build-test-'));
  tempDirs.push(root);
  const sourceDir = path.join(root, 'src');
  const outputDir = path.join(root, 'out');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(sourceDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
    'utf8',
  );
  await fs.writeFile(
    path.join(sourceDir, 'deno.json'),
    JSON.stringify({
      nodeModulesDir: 'auto',
      compilerOptions: {
        strict: true,
        jsx: 'react-jsx',
        jsxImportSource: 'react',
        lib: ['deno.ns', 'dom', 'dom.iterable', 'dom.asynciterable', 'esnext'],
      },
      allowScripts: [],
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(sourceDir, 'deno.lock'),
    JSON.stringify({
      version: '5',
      specifiers: {},
      npm: {},
      workspace: { packageJson: { dependencies: [] } },
    }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(sourceDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { sourceDir, outputDir };
}

async function useDefaultDependencyFiles(sourceDir: string): Promise<void> {
  const templateRoot = new URL(
    '../../../templates/default-app/',
    import.meta.url,
  );
  const packageJson = (
    await fs.readFile(new URL('package.json', templateRoot), 'utf8')
  ).replaceAll('__APP_ID__', 'demo');
  await Promise.all([
    fs.writeFile(path.join(sourceDir, 'package.json'), packageJson, 'utf8'),
    fs.copyFile(
      new URL('deno.lock', templateRoot),
      path.join(sourceDir, 'deno.lock'),
    ),
    fs.copyFile(
      new URL('deno.json', templateRoot),
      path.join(sourceDir, 'deno.json'),
    ),
  ]);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('buildApp backend', () => {
  it('emits a self-contained bundle with only fixed runtime assets', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts':
          "import { readMarker } from './lib/read-marker.ts';\n" +
          'console.log(await readMarker());\n',
        'backend/lib/read-marker.ts':
          "import path from 'node:path';\n" +
          'export function readMarker() {\n' +
          "  const assetsDir = Deno.env.get('HATCH_ASSETS_DIR');\n" +
          "  if (!assetsDir) throw new Error('missing assets directory');\n" +
          "  return Deno.readTextFile(path.join(assetsDir, 'data/message.txt'));\n" +
          '}\n',
        'backend/assets/data/message.txt': 'runtime asset',
        'backend/assets/.git/metadata': 'asset named like build metadata',
        'backend/assets/node_modules/data.json': '{"asset":true}',
        'backend/not-staged.txt': 'must not ship',
        'gen/service_pb.ts': "export const generated = 'unused';\n",
      },
    );

    const result = await buildApp('demo', { sourceDir, outputDir });
    const bundlePath = path.join(outputDir, 'backend', 'main.bundle.js');

    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
    await expect(fs.readFile(bundlePath, 'utf8')).resolves.not.toContain(
      'sourceMappingURL=',
    );
    await expect(fs.access(`${bundlePath}.map`)).rejects.toThrow(/ENOENT/);
    await expect(
      fs.readFile(
        path.join(outputDir, 'backend', 'assets', 'data', 'message.txt'),
        'utf8',
      ),
    ).resolves.toBe('runtime asset');
    await expect(
      fs.readFile(
        path.join(outputDir, 'backend', 'assets', 'node_modules', 'data.json'),
        'utf8',
      ),
    ).resolves.toBe('{"asset":true}');
    await expect(
      fs.readFile(
        path.join(outputDir, 'backend', 'assets', '.git', 'metadata'),
        'utf8',
      ),
    ).resolves.toBe('asset named like build metadata');
    for (const omitted of [
      'backend/main.ts',
      'backend/lib/read-marker.ts',
      'backend/not-staged.txt',
      'gen/service_pb.ts',
      'package.json',
      'deno.json',
      'deno.lock',
    ]) {
      await expect(fs.access(path.join(outputDir, omitted))).rejects.toThrow(
        /ENOENT/,
      );
    }

    expect(result.normalized.backend).toEqual({
      entry: 'backend/main.bundle.js',
      format: 'bundle-v1',
    });
    expect(result.log).toContain(
      'deno install --no-config --package-json --node-modules-dir=auto ' +
        '--lock=deno.lock --frozen',
    );
    expect(result.log).toContain(
      'deno check --config=deno.json --no-remote ' + '--node-modules-dir=auto',
    );
    expect(result.log).toContain(
      'deno bundle --config=deno.json --no-remote --platform=deno',
    );
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(outputDir, 'manifest.normalized.json'),
        'utf8',
      ),
    );
    expect(persisted.backend).toEqual(result.normalized.backend);

    const executed = await execFileAsync(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--cached-only',
        `--allow-read=${path.join(outputDir, 'backend', 'assets')}`,
        '--allow-env=HATCH_ASSETS_DIR',
        bundlePath,
      ],
      {
        cwd: outputDir,
        env: {
          ...process.env,
          HATCH_ASSETS_DIR: path.join(outputDir, 'backend', 'assets'),
        },
      },
    );
    expect(executed.stdout.trim()).toBe('runtime asset');
  });

  it('rejects npm lifecycle approvals without executing an install', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );
    const configPath = path.join(sourceDir, 'deno.json');
    const lockPath = path.join(sourceDir, 'deno.lock');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      allowScripts: string[];
    };
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      npm: Record<string, unknown>;
    };
    config.allowScripts = ['npm:test-lifecycle@1.2.3'];
    lock.npm['test-lifecycle@1.2.3'] = {};
    await Promise.all([
      fs.writeFile(configPath, JSON.stringify(config), 'utf8'),
      fs.writeFile(lockPath, JSON.stringify(lock), 'utf8'),
    ]);

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /allowScripts must be absent or an empty array/,
    );
    await expect(fs.access(outputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates an empty fixed assets directory when the source omits it', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );

    await buildApp('demo', { sourceDir, outputDir });

    await expect(
      fs.readdir(path.join(outputDir, 'backend', 'assets')),
    ).resolves.toEqual([]);
  });

  it('resolves explicit relative imports before emitting an offline bundle', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts':
          "import { value } from './value.ts';\nconsole.log(value);\n",
        'backend/value.ts': "export const value = 'aliased';\n",
      },
    );

    await buildApp('demo', { sourceDir, outputDir });

    const bundlePath = path.join(outputDir, 'backend', 'main.bundle.js');
    const executed = await execFileAsync(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--cached-only',
        bundlePath,
      ],
      { cwd: outputDir },
    );
    expect(executed.stdout.trim()).toBe('aliased');
  });

  it('bundles installed npm modules into the runtime artifact', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts':
          "import { z } from 'zod';\nconsole.log(typeof z.object);\n",
      },
    );
    await useDefaultDependencyFiles(sourceDir);

    await buildApp('demo', { sourceDir, outputDir });

    const bundlePath = path.join(outputDir, 'backend', 'main.bundle.js');
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
    const executed = await execFileAsync(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--cached-only',
        bundlePath,
      ],
      { cwd: outputDir },
    );
    expect(executed.stdout.trim()).toBe('function');
  }, 15_000);

  it('does not reuse nested source node_modules installations', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts':
          "import value from 'source-only-package';\nconsole.log(value);\n",
        'backend/node_modules/source-only-package/package.json': JSON.stringify(
          {
            name: 'source-only-package',
            version: '1.0.0',
            type: 'module',
            exports: './index.js',
          },
        ),
        'backend/node_modules/source-only-package/index.js':
          "export default 'must not bundle';\n",
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /Source validation failed during deno check[\s\S]*source-only-package/,
    );
  });

  it('rejects symbolic links below the fixed assets directory', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts': "console.log('ok');\n",
        'backend/private.txt': 'must not escape into assets',
        'backend/assets/real.txt': 'asset',
      },
    );
    await fs.symlink(
      path.join(sourceDir, 'backend', 'private.txt'),
      path.join(sourceDir, 'backend', 'assets', 'linked.txt'),
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'backend asset must not be a symbolic link: backend/assets/linked.txt',
    );
  });

  it('rejects a symbolic link used as the fixed assets directory', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts': "console.log('ok');\n",
        'backend/private-assets/secret.txt': 'must not ship',
      },
    );
    await fs.symlink(
      path.join(sourceDir, 'backend', 'private-assets'),
      path.join(sourceDir, 'backend', 'assets'),
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'backend asset directory must not be a symbolic link: backend/assets',
    );
  });

  it('rejects a symbolic link used as the backend source directory', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );
    const linkedBackend = path.join(path.dirname(sourceDir), 'linked-backend');
    await fs.rename(path.join(sourceDir, 'backend'), linkedBackend);
    await fs.symlink(linkedBackend, path.join(sourceDir, 'backend'));

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'backend source directory must not be a symbolic link: backend',
    );
  });

  it('rejects symbolic links in authored backend bundle sources', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "import './linked.ts';\n" },
    );
    const outsideModule = path.join(path.dirname(sourceDir), 'outside.ts');
    await fs.writeFile(outsideModule, "console.log('outside');\n", 'utf8');
    await fs.symlink(
      outsideModule,
      path.join(sourceDir, 'backend', 'linked.ts'),
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'backend bundle source must not be a symbolic link: backend/linked.ts',
    );
  });

  it('ignores source-owned generated directories before validation', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );
    const external = path.join(path.dirname(sourceDir), 'untrusted-generated');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(
      path.join(external, 'poison.ts'),
      'const invalid: string = 1;\n',
      'utf8',
    );
    await Promise.all([
      fs.symlink(external, path.join(sourceDir, '.hatch'), 'dir'),
      fs.symlink(external, path.join(sourceDir, 'gen'), 'dir'),
    ]);

    await expect(
      buildApp('demo', { sourceDir, outputDir }),
    ).resolves.toMatchObject({
      normalized: { backend: { format: 'bundle-v1' } },
    });
    await expect(fs.access(path.join(outputDir, '.hatch'))).rejects.toThrow(
      /ENOENT/,
    );
    await expect(fs.access(path.join(outputDir, 'gen'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe('buildApp source validation', () => {
  it('preserves authored nested directories named like generated roots', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'app/main.ts':
          "import { marker } from './gen/helper.ts';\n" +
          'document.body.dataset.marker = marker;\n',
        'app/gen/helper.ts':
          "export const marker = 'nested-authored-gen-marker';\n",
        'app/index.html': '<html><body></body></html>',
      },
    );

    await buildApp('demo', { sourceDir, outputDir });

    await expect(
      fs.readFile(path.join(outputDir, 'app', 'index.html'), 'utf8'),
    ).resolves.toContain('nested-authored-gen-marker');
  });

  it('treats option-looking manifest entries as source paths', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: '--help',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        '--help': 'const invalid: string = 1;\n',
        'app/index.html': '<html><body></body></html>',
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /Source validation failed during deno check[\s\S]*Type 'number' is not assignable to type 'string'/,
    );
    await expect(fs.access(outputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects remote source imports during Deno check', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'app/main.ts':
          "import 'https://example.com/remote.ts';\nconsole.log('ok');\n",
        'app/index.html': '<html><body></body></html>',
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /Source validation failed during deno check[\s\S]*Requires import access/i,
    );
    await expect(fs.access(outputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a declared RPC proto that is missing', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        rpc: {
          proto: 'proto/service.proto',
          service: 'app.v1.DemoService',
        },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'keep.txt'), 'existing', 'utf8');

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'RPC proto declared by manifest.json was not found: proto/service.proto',
    );
    await expect(
      fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'),
    ).resolves.toBe('existing');
  });

  it('rejects a declared RPC proto path that is a directory', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        rpc: {
          proto: 'proto/service.proto',
          service: 'app.v1.DemoService',
        },
        backend: { entry: 'backend/main.ts' },
      },
      { 'backend/main.ts': "console.log('ok');\n" },
    );
    await fs.mkdir(path.join(sourceDir, 'proto', 'service.proto'), {
      recursive: true,
    });

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'RPC proto declared by manifest.json must be a regular file: proto/service.proto',
    );
  });

  it('rejects a declared RPC service that is absent from the proto', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        rpc: {
          proto: 'proto/service.proto',
          service: 'app.v1.MissingService',
        },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts': "console.log('ok');\n",
        'proto/service.proto':
          'syntax = "proto3";\n' +
          'package app.v1;\n' +
          'message Request {}\n' +
          'message Reply {}\n' +
          'service DemoService { rpc Run(Request) returns (Reply); }\n',
      },
    );
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'keep.txt'), 'existing', 'utf8');

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      'RPC service declared by manifest.json was not found in the compiled proto: app.v1.MissingService',
    );
    await expect(
      fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'),
    ).resolves.toBe('existing');
  });

  it('checks every enabled manifest entry before replacing build output', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: {
          frontend: true,
          backend: true,
          widgets: true,
          userscripts: true,
          dataTable: true,
        },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
        backend: { entry: 'backend/main.ts' },
        widgets: [
          {
            id: 'counter',
            name: 'Counter',
            entry: 'widgets/counter.ts',
          },
        ],
        userscripts: [
          {
            id: 'watch',
            name: 'Watch',
            entry: 'userscripts/watch.ts',
            matches: ['https://example.com/*'],
          },
        ],
      },
      {
        'app/main.ts': 'const appValue: string = 1;\n',
        'app/index.html': '<html><body></body></html>',
        'backend/main.ts': 'const backendValue: string = 1;\n',
        'widgets/counter.ts': 'const widgetValue: string = 1;\n',
        'userscripts/watch.ts': 'const userscriptValue: string = 1;\n',
        'data/schema.ts':
          'const schemaValue: string = 1;\n' +
          'export default { descriptor: {} };\n',
      },
    );
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'keep.txt'), 'existing', 'utf8');

    const error = await buildApp('demo', { sourceDir, outputDir }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Source validation failed during deno check');
    for (const entry of [
      'app/main.ts',
      'backend/main.ts',
      'widgets/counter.ts',
      'userscripts/watch.ts',
      'data/schema.ts',
    ]) {
      expect(message).toContain(entry);
    }
    await expect(
      fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'),
    ).resolves.toBe('existing');
  });
});

describe('buildApp fixed browser configuration', () => {
  it.each(['preserve', 'precompile'])(
    'rejects unsupported browser JSX mode %s',
    async (jsx) => {
      const { sourceDir, outputDir } = await makeAppSource(
        {
          id: 'demo',
          name: 'Demo',
          capabilities: { frontend: true },
          app: {
            entry: 'app/main.ts',
            html: 'app/index.html',
            routes: [],
          },
        },
        {
          'deno.json': JSON.stringify({
            compilerOptions: {
              strict: true,
              jsx,
              jsxImportSource: 'react',
            },
            allowScripts: [],
          }),
          'app/main.ts': "console.log('ok');\n",
          'app/index.html': '<html><body></body></html>',
        },
      );

      await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
        /compilerOptions.jsx must be "react-jsx"/,
      );
    },
  );

  it('rejects a custom jsxImportSource', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.tsx',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'deno.json': JSON.stringify({
          nodeModulesDir: 'auto',
          compilerOptions: {
            strict: true,
            jsx: 'react-jsx',
            jsxImportSource: '#jsx',
            lib: ['deno.ns', 'dom', 'esnext'],
          },
          allowScripts: [],
        }),
        'app/main.tsx':
          "const view = <custom-element value='ok' />;\n" +
          'document.body.dataset.view = JSON.stringify(view);\n',
        'app/custom-jsx/jsx-runtime.ts':
          'export namespace JSX {\n' +
          '  export interface IntrinsicElements {\n' +
          '    [name: string]: Record<string, unknown>;\n' +
          '  }\n' +
          '}\n' +
          'export const Fragment = Symbol();\n' +
          'export function jsx(type: unknown, props: unknown) {\n' +
          "  return { type, props, runtime: 'custom-jsx-runtime-marker' };\n" +
          '}\n' +
          'export { jsx as jsxs };\n',
        'app/index.html': '<html><body></body></html>',
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /compilerOptions.jsxImportSource must be "react"/,
    );
  });

  it('rejects App-owned import maps', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'deno.json': JSON.stringify({
          allowScripts: [],
          imports: { '#message': './app/default-message.ts' },
          scopes: {
            './app/': { '#message': './app/scoped-message.ts' },
          },
        }),
        'app/main.ts':
          "import { message } from '#message';\nconsole.log(message);\n",
        'app/default-message.ts':
          "export const message = 'default-import-map-message';\n",
        'app/scoped-message.ts':
          "export const message = 'scoped-import-map-message';\n",
        'app/index.html': '<html><body></body></html>',
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /App deno.json must not declare imports/,
    );
  });

  it('rejects App-owned import-map scopes', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'deno.json': JSON.stringify({
          allowScripts: [],
          compilerOptions: {
            strict: true,
            jsx: 'react-jsx',
            jsxImportSource: 'react',
          },
          scopes: {
            './app/': {
              './app/original.ts': './app/replacement.ts',
            },
          },
        }),
        'app/main.ts':
          "import { message } from './original.ts';\nconsole.log(message);\n",
        'app/replacement.ts':
          "export const message = 'normalized-relative-key-message';\n",
        'app/index.html': '<html><body></body></html>',
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /App deno.json must not declare scopes/,
    );
  });

  it('rejects App-owned import-map targets before building', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'deno.json': JSON.stringify({
          allowScripts: [],
          imports: { '#outside': '../outside.ts' },
        }),
        'app/main.ts':
          "import { outside } from '#outside';\nconsole.log(outside);\n",
        'app/index.html': '<html><body></body></html>',
      },
    );
    await fs.writeFile(
      path.join(path.dirname(sourceDir), 'outside.ts'),
      "export const outside = 'must-not-be-read';\n",
      'utf8',
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /App deno.json must not declare imports/,
    );
    await expect(fs.access(outputDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('buildApp userscripts', () => {
  it('uses the fixed React automatic JSX runtime when bundling userscripts', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { userscripts: true },
        userscripts: [
          {
            id: 'watch',
            name: 'Watch',
            entry: 'userscripts/watch.tsx',
            matches: ['https://example.com/*'],
          },
        ],
      },
      {
        'userscripts/watch.tsx':
          'const view = <div data-marker="fixed-react-jsx-marker" />;\n' +
          'document.body.dataset.view = JSON.stringify(view);\n',
      },
    );
    await useDefaultDependencyFiles(sourceDir);

    await buildApp('demo', { sourceDir, outputDir });

    const bundled = await fs.readFile(
      path.join(outputDir, 'userscripts', 'watch.js'),
      'utf8',
    );
    expect(bundled).toContain('fixed-react-jsx-marker');
  }, 15_000);

  it('bundles each userscript to userscripts/<id>.js and normalizes metadata', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { userscripts: true },
        userscripts: [
          {
            id: 'watch',
            name: 'Watch',
            entry: 'userscripts/watch.ts',
            matches: ['https://example.com/*'],
            grants: ['GM_setValue'],
          },
        ],
      },
      {
        'userscripts/watch.ts':
          "const marker = 'hatch-userscript-marker';\ndocument.title = marker;\n",
      },
    );

    const result = await buildApp('demo', { sourceDir, outputDir });

    const bundled = await fs.readFile(
      path.join(outputDir, 'userscripts', 'watch.js'),
      'utf8',
    );
    expect(bundled).toContain('hatch-userscript-marker');
    // IIFE output must not carry ESM syntax (Tampermonkey injects a classic script).
    expect(bundled).not.toMatch(/^\s*export\s/m);

    expect(result.normalized.userscripts).toEqual([
      {
        id: 'watch',
        name: 'Watch',
        url: '/api/app/demo/userscripts/watch.user.js',
        matches: ['https://example.com/*'],
        grants: ['GM_setValue'],
        connects: [],
        noframes: false,
        extraMetadata: {},
      },
    ]);

    // The normalized manifest is persisted alongside the bundle.
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(outputDir, 'manifest.normalized.json'),
        'utf8',
      ),
    );
    expect(persisted.userscripts).toHaveLength(1);
  });

  it('fails the build when a declared userscript entry is missing', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { userscripts: true },
        userscripts: [
          {
            id: 'watch',
            name: 'Watch',
            entry: 'userscripts/missing.ts',
            matches: ['https://example.com/*'],
          },
        ],
      },
      {},
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /userscript entry not found/,
    );
  });
});

describe('buildApp managed Data Tables', () => {
  it('does not overwrite an authored module while evaluating the schema', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { dataTable: true, frontend: true },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        '__hatch_describe_data.ts':
          "export const marker = 'authored-schema-runner-name';\n",
        'app/main.ts':
          "import { marker } from '../__hatch_describe_data.ts';\n" +
          'document.body.dataset.marker = marker;\n',
        'app/index.html': '<html><body></body></html>',
        'data/schema.ts': `
          import { defineSchema, defineTable, t } from '@hatch/data';
          export default defineSchema({
            items: defineTable({ name: t.string() }),
          });
        `,
      },
    );

    await buildApp('demo', { sourceDir, outputDir });

    await expect(
      fs.readFile(path.join(outputDir, 'app', 'index.html'), 'utf8'),
    ).resolves.toContain('authored-schema-runner-name');
  });

  it('rejects source symlinks before writing platform build files', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { dataTable: true },
      },
      {
        'data/schema.ts': 'export default { descriptor: {} };',
      },
    );
    const external = path.join(path.dirname(sourceDir), 'external');
    const externalFile = path.join(external, 'keep.txt');
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(externalFile, 'do not overwrite', 'utf8');
    await fs.symlink(external, path.join(sourceDir, 'linked'), 'dir');

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /may not contain symbolic links: linked/,
    );
    await expect(fs.readFile(externalFile, 'utf8')).resolves.toBe(
      'do not overwrite',
    );
  });

  it('evaluates schemas and inlines the platform-provided Data SDK', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { dataTable: true, frontend: true, backend: true },
        backend: { entry: 'backend/main.ts' },
        app: {
          entry: 'app/main.ts',
          html: 'app/index.html',
          routes: [],
        },
      },
      {
        'app/main.ts': `
          import { useDataQuery } from '@hatch/data/react';
          declare const __DATA_DEPLOYMENT_ID__: string;
          document.body.dataset.deploymentId = __DATA_DEPLOYMENT_ID__;
          document.body.dataset.sdk = typeof useDataQuery;
        `,
        'app/index.html': '<html><body></body></html>',
        'backend/main.ts': `
          import schema from '../data/schema.ts';
          import { runtimeValue } from './runtime-value.ts';
          import { createDataClient } from '@hatch/data';
          export const data = createDataClient<typeof schema>({
            baseUrl: Deno.env.get('HATCH_DATA_URL') ?? '',
          });
          export const importedRuntimeValue = runtimeValue;
          export const incrementAttempts = (id: string) =>
            data.increment('todos', id, 'attempts', 1);
          console.log(JSON.stringify({
            runtime: importedRuntimeValue,
            sdk: typeof data.increment,
          }));
        `,
        'backend/runtime-value.ts':
          "export const runtimeValue = 'runtime-alias';\n",
        'data/fields.ts': "export const titleFieldName = 'title' as const;\n",
        'data/schema.ts': `
          import { titleFieldName } from './fields.ts';
          import { defineSchema, defineTable, t } from '@hatch/data';
          export default defineSchema({
            todos: defineTable({
              [titleFieldName]: t.string(),
              completed: t.boolean().default(false),
              attempts: t.integer().default(0),
            }).index('by_completed', ['completed']),
          });
        `,
      },
    );
    await useDefaultDependencyFiles(sourceDir);

    const result = await buildApp('demo', {
      sourceDir,
      outputDir,
      deploymentId: 'deployment-123',
    });

    expect(result.dataSchema?.tables.todos).toMatchObject({
      fields: {
        title: { kind: 'string', optional: false },
        completed: { kind: 'boolean', optional: false, default: false },
        attempts: { kind: 'integer', optional: false, default: 0 },
      },
      indexes: [{ name: 'by_completed', fields: ['completed'], unique: false }],
    });
    expect(result.normalized.dataTable).toEqual({
      url: '/api/app/demo/data',
    });
    expect(result.log).toContain(
      'deno run --no-prompt --config=deno.json --no-remote ' +
        '--node-modules-dir=auto',
    );
    await expect(
      fs.readFile(path.join(outputDir, 'app', 'index.html'), 'utf8'),
    ).resolves.toContain('deployment-123');
    await expect(
      fs.readFile(path.join(outputDir, 'deployment.json'), 'utf8'),
    ).resolves.toContain('deployment-123');
    expect(result.normalized.backend).toEqual({
      entry: 'backend/main.bundle.js',
      format: 'bundle-v1',
    });

    const bundlePath = path.join(outputDir, 'backend', 'main.bundle.js');
    await expect(fs.access(bundlePath)).resolves.toBeUndefined();
    for (const buildOnlyPath of [
      HATCH_SDK_IMPORT_MAP,
      'node_modules/@hatch/data',
      'node_modules/react',
      'backend/main.ts',
      'backend/runtime-value.ts',
      'data/schema.ts',
      'data/fields.ts',
      'deno.json',
      'deno.lock',
    ]) {
      await expect(
        fs.access(path.join(outputDir, buildOnlyPath)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }

    // Relative App imports and the SDK must already be inside the bundle: the
    // final artifact runs with an empty cache and external resolution disabled.
    const recoveryCache = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hatch-data-recovery-cache-'),
    );
    tempDirs.push(recoveryCache);
    const executed = await execFileAsync(
      'deno',
      [
        'run',
        '--no-config',
        '--no-lock',
        '--no-npm',
        '--no-remote',
        '--cached-only',
        '--allow-env=HATCH_DATA_URL,HATCH_DATA_DEPLOYMENT_ID',
        bundlePath,
      ],
      {
        cwd: outputDir,
        env: { ...process.env, DENO_DIR: recoveryCache },
      },
    );
    expect(JSON.parse(executed.stdout.trim())).toEqual({
      runtime: 'runtime-alias',
      sdk: 'function',
    });
  }, 15_000);

  it('rejects a local external import map', async () => {
    const externalMap = {
      imports: { '#helper': '../backend/helper.ts' },
    };
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'deno.json': JSON.stringify({
          allowScripts: [],
          importMap: './config/import-map.json',
        }),
        'config/import-map.json': JSON.stringify(externalMap),
        'backend/helper.ts': "export const helper = 'helper';\n",
        'backend/main.ts': `
          import { helper } from '#helper';
          export const importedHelper = helper;
          console.log(importedHelper);
        `,
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /App deno.json must not declare importMap/,
    );
  });

  it('rejects schema dependencies missing from the committed lock', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { dataTable: true },
      },
      {
        'data/schema.ts': `
          import 'npm:zod@4.4.3';
          import { defineSchema, defineTable, t } from '@hatch/data';
          export default defineSchema({
            todos: defineTable({ title: t.string() }),
          });
        `,
      },
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /Source validation failed during deno check[\s\S]*npm:zod@4\.4\.3/i,
    );
  });

  it('rejects a Data Table capability without data/schema.ts', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { dataTable: true },
      },
      {},
    );

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /data\/schema\.ts does not exist/,
    );
  });
});
