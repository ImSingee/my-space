import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setAgentOwned } = vi.hoisted(() => ({
  setAgentOwned: vi.fn<(targets: readonly string[]) => void>(),
}));

vi.mock('./shell-sandbox', () => ({ setAgentOwned }));

import {
  appHatchDataPackageDir,
  appHatchImportMapPath,
  HATCH_SDK_IMPORT_MAP,
  HATCH_SDK_IMPORTS,
  materializeAppHatchSdk,
} from './hatch-sdk';

const roots: string[] = [];
const exec = promisify(execFile);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-sdk-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  setAgentOwned.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('App Hatch SDK materialization', () => {
  it('transfers complete temporary SDK files to the Agent owner', async () => {
    const root = await tempRoot();
    setAgentOwned.mockImplementationOnce((targets) => {
      expect(targets).toHaveLength(2);
      expect(path.basename(targets[0] ?? '')).toMatch(/^\.data-/);
      expect(path.basename(targets[1] ?? '')).toMatch(/^\.import-map-/);
      expect(targets.every((target) => existsSync(target))).toBe(true);
      expect(existsSync(path.join(targets[0] ?? '', 'dist', 'data.js'))).toBe(
        true,
      );
    });

    await materializeAppHatchSdk(root);

    expect(setAgentOwned).toHaveBeenCalledOnce();
  });

  it('does not install SDK files when ownership transfer fails', async () => {
    const root = await tempRoot();
    setAgentOwned.mockImplementationOnce(() => {
      throw new Error('chown failed');
    });

    await expect(materializeAppHatchSdk(root)).rejects.toThrow('chown failed');
    expect(existsSync(appHatchDataPackageDir(root))).toBe(false);
    expect(existsSync(appHatchImportMapPath(root))).toBe(false);
  });

  it('creates a versionless package that Deno can resolve locally', async () => {
    const root = await tempRoot();

    await materializeAppHatchSdk(root);

    const packageDir = appHatchDataPackageDir(root);
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: '@hatch/data', private: true });
    expect(manifest).not.toHaveProperty('version');
    await expect(
      readFile(path.join(packageDir, 'dist', 'data.js'), 'utf8'),
    ).resolves.toContain('@ts-self-types="./data.d.ts"');
    await expect(
      readFile(path.join(packageDir, 'dist', 'data-react.js'), 'utf8'),
    ).resolves.toContain('@ts-self-types="./data-react.d.ts"');
    const importMap = JSON.parse(
      await readFile(appHatchImportMapPath(root), 'utf8'),
    ) as Record<string, unknown>;
    expect(HATCH_SDK_IMPORT_MAP).toBe('node_modules/@hatch/import-map.json');
    expect(importMap).toEqual({ imports: HATCH_SDK_IMPORTS });
    expect(HATCH_SDK_IMPORTS).toEqual({
      '@hatch/data': './data/dist/data.js',
      '@hatch/data/react': './data/dist/data-react.js',
    });
  });

  it('refreshes stale generated SDK files', async () => {
    const root = await tempRoot();
    await materializeAppHatchSdk(root);
    const generated = path.join(
      appHatchDataPackageDir(root),
      'dist',
      'data.js',
    );
    await writeFile(generated, 'stale', 'utf8');
    await writeFile(appHatchImportMapPath(root), 'stale', 'utf8');

    await materializeAppHatchSdk(root);

    await expect(readFile(generated, 'utf8')).resolves.not.toBe('stale');
    await expect(
      readFile(appHatchImportMapPath(root), 'utf8'),
    ).resolves.not.toBe('stale');
  });

  it('provides Deno types without a package or lockfile entry', async () => {
    const root = await tempRoot();
    const denoDir = await tempRoot();
    await mkdir(path.join(root, 'backend'));
    await Promise.all([
      writeFile(
        path.join(root, 'deno.json'),
        JSON.stringify({
          allowScripts: [],
          imports: {
            '#package': 'jsr:@std/async@1',
            '#shared': './backend/shared.ts',
          },
          scopes: {
            './backend/': { '#scoped': './backend/scoped.ts' },
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(root, 'deno.lock'),
        JSON.stringify({
          version: '5',
          specifiers: {},
          npm: {},
          workspace: { dependencies: [] },
        }),
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'shared.ts'),
        "export const shared = 'shared';\n",
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'scoped.ts'),
        "export const scoped = 'scoped';\n",
        'utf8',
      ),
      writeFile(
        path.join(root, 'resolve.ts'),
        "console.log(import.meta.resolve('#package/delay'));\n",
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'check.ts'),
        `
          import { createDataClient, defineSchema, defineTable, t } from '@hatch/data';
          import { shared } from '#shared';
          import { scoped } from '#scoped';
          const schema = defineSchema({ counters: defineTable({ value: t.integer() }) });
          const data = createDataClient<typeof schema>({ baseUrl: 'http://hatch.test' });
          await data.increment('counters', 'counter-1', 'value', 1);
          console.log(shared, scoped);
        `,
        'utf8',
      ),
    ]);
    const directResolution = await exec(
      'deno',
      ['run', '--lock=deno.lock', '--frozen', 'resolve.ts'],
      { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
    );
    await materializeAppHatchSdk(root);

    const generatedResolution = await exec(
      'deno',
      [
        'run',
        `--import-map=${HATCH_SDK_IMPORT_MAP}`,
        '--lock=deno.lock',
        '--frozen',
        'resolve.ts',
      ],
      { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
    );
    expect(generatedResolution.stdout).toBe(directResolution.stdout);

    await expect(
      exec(
        'deno',
        [
          'check',
          '--node-modules-dir=none',
          `--import-map=${HATCH_SDK_IMPORT_MAP}`,
          '--lock=deno.lock',
          '--frozen',
          'backend/check.ts',
        ],
        { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
      ),
    ).resolves.toBeDefined();
    const importMap = JSON.parse(
      await readFile(appHatchImportMapPath(root), 'utf8'),
    );
    expect(importMap).toEqual({
      imports: {
        '#package': 'jsr:@std/async@1',
        '#package/': 'jsr:/@std/async@1/',
        '#shared': '../../backend/shared.ts',
        ...HATCH_SDK_IMPORTS,
      },
      scopes: {
        '../../backend/': { '#scoped': '../../backend/scoped.ts' },
      },
    });
    expect(JSON.stringify(importMap)).not.toContain(root);
    const lock = await readFile(path.join(root, 'deno.lock'), 'utf8');
    expect(lock).not.toContain('@hatch/data');
  });

  it('merges a source-contained external import map', async () => {
    const root = await tempRoot();
    const denoDir = await tempRoot();
    await Promise.all([
      mkdir(path.join(root, 'config')),
      mkdir(path.join(root, 'backend')),
    ]);
    await Promise.all([
      writeFile(
        path.join(root, 'deno.json'),
        JSON.stringify({ importMap: './config/import-map.json' }),
        'utf8',
      ),
      writeFile(
        path.join(root, 'config', 'import-map.json'),
        JSON.stringify({
          imports: { '#shared': '../backend/shared.ts' },
          scopes: {
            '../backend/': { '#scoped': '../backend/scoped.ts' },
          },
        }),
        'utf8',
      ),
      writeFile(
        path.join(root, 'deno.lock'),
        JSON.stringify({
          version: '5',
          specifiers: {},
          npm: {},
          workspace: { dependencies: [] },
        }),
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'shared.ts'),
        "export const shared = 'shared';\n",
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'scoped.ts'),
        "export const scoped = 'scoped';\n",
        'utf8',
      ),
      writeFile(
        path.join(root, 'backend', 'check.ts'),
        "import { shared } from '#shared';\nimport { scoped } from '#scoped';\nconsole.log(shared, scoped);\n",
        'utf8',
      ),
    ]);

    await materializeAppHatchSdk(root);

    await expect(
      readFile(appHatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({
      imports: {
        '#shared': '../../backend/shared.ts',
        ...HATCH_SDK_IMPORTS,
      },
      scopes: {
        '../../backend/': { '#scoped': '../../backend/scoped.ts' },
      },
    });

    await expect(
      exec(
        'deno',
        [
          'check',
          '--node-modules-dir=none',
          `--import-map=${HATCH_SDK_IMPORT_MAP}`,
          '--lock=deno.lock',
          '--frozen',
          'backend/check.ts',
        ],
        { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
      ),
    ).resolves.toBeDefined();
  });

  it.each([
    {
      label: 'top-level import',
      config: { imports: { '@hatch/data': './fake.ts' } },
    },
    {
      label: 'scoped import',
      config: {
        scopes: { './backend/': { '@hatch/': './fake/' } },
      },
    },
  ])('rejects an App-managed Hatch $label', async ({ config }) => {
    const root = await tempRoot();
    await writeFile(
      path.join(root, 'deno.json'),
      JSON.stringify(config),
      'utf8',
    );

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      'must not map platform-owned specifier',
    );
  });

  it('refuses a symlinked deno.json without reading its target', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const target = path.join(outside, 'deno.json');
    await writeFile(target, JSON.stringify({ imports: {} }), 'utf8');
    await symlink(target, path.join(root, 'deno.json'));

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      'deno.json must not contain symbolic links',
    );
  });

  it('refuses a symlinked managed package without touching its target', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(path.join(root, 'node_modules', '@hatch'), {
      recursive: true,
    });
    const marker = path.join(outside, 'marker');
    await writeFile(marker, 'keep me', 'utf8');
    await symlink(outside, appHatchDataPackageDir(root));

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      '@hatch/data SDK: data is a symbolic link',
    );
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep me');
  });

  it('refuses a symlinked import map without touching its target', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(path.join(root, 'node_modules', '@hatch'), {
      recursive: true,
    });
    const target = path.join(outside, 'import-map.json');
    await writeFile(target, 'keep me', 'utf8');
    await symlink(target, appHatchImportMapPath(root));

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      '@hatch/data SDK: import-map.json is a symbolic link',
    );
    await expect(readFile(target, 'utf8')).resolves.toBe('keep me');
  });

  it('refuses a symlinked node_modules parent', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, path.join(root, 'node_modules'));

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      '@hatch/data SDK: node_modules is a symbolic link',
    );
    await expect(
      readFile(path.join(outside, '@hatch', 'data', 'package.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
