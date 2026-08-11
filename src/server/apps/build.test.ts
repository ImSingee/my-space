import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
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
    JSON.stringify({ allowScripts: [] }),
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
      new URL('deno.json', templateRoot),
      path.join(sourceDir, 'deno.json'),
    ),
    fs.copyFile(
      new URL('deno.lock', templateRoot),
      path.join(sourceDir, 'deno.lock'),
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

  it('resolves deno.json import aliases before emitting an offline bundle', async () => {
    const { sourceDir, outputDir } = await makeAppSource(
      {
        id: 'demo',
        name: 'Demo',
        capabilities: { backend: true },
        backend: { entry: 'backend/main.ts' },
      },
      {
        'backend/main.ts':
          "import { value } from '#value';\nconsole.log(value);\n",
        'backend/value.ts': "export const value = 'aliased';\n",
      },
    );
    await fs.writeFile(
      path.join(sourceDir, 'deno.json'),
      JSON.stringify({
        allowScripts: [],
        imports: { '#value': './backend/value.ts' },
      }),
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
          "import postgres from 'postgres';\nconsole.log(typeof postgres);\n",
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
  });

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
      /Backend bundle failed/,
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
});

describe('buildApp userscripts', () => {
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
        url: '/api/apps/demo/userscripts/watch.user.js',
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
