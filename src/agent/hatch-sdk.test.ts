import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const originalDataDir = process.env.HATCH_DATA_DIR;
const testDataRoot = await mkdtemp(path.join(os.tmpdir(), 'hatch-sdk-data-'));
await chmod(testDataRoot, 0o755);
process.env.HATCH_DATA_DIR = testDataRoot;
const [hatchSdkModule, pathsModule, sandboxModule] = await Promise.all([
  import('./hatch-sdk'),
  import('./paths'),
  import('./shell-sandbox'),
]);
const {
  APP_HATCH_SDK_IMPORTS,
  appHatchDataPackageDir,
  hatchImportMapPath,
  HATCH_BUF_GEN_CONFIG,
  HATCH_SDK_IMPORT_MAP,
  materializeAppHatchSdk,
  materializeWorkflowHatchSdk,
  workflowHatchPackageDir,
  WORKFLOW_HATCH_SDK_IMPORTS,
} = hatchSdkModule;
const { agentSessionDir, agentWorkDir } = pathsModule;
const { prepareAgentSessionSandbox, setAgentOwned } = sandboxModule;

const roots: string[] = [];
const exec = promisify(execFile);

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-sdk-test-'));
  roots.push(root);
  return root;
}

async function tempAgentRoot(): Promise<string> {
  const sessionId = `hatch-sdk-${randomUUID()}`;
  prepareAgentSessionSandbox(sessionId);
  const root = await mkdtemp(
    path.join(agentWorkDir(sessionId), 'hatch-sdk-test-'),
  );
  roots.push(agentSessionDir(sessionId));
  setAgentOwned([root], sessionId);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      await exec('chmod', ['-R', 'u+rwX', root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.HATCH_DATA_DIR;
  else process.env.HATCH_DATA_DIR = originalDataDir;
  await rm(testDataRoot, { recursive: true, force: true });
});

describe('App Hatch SDK materialization', () => {
  it('stages outside the App root and installs a read-only generation', async () => {
    const root = await tempRoot();

    await materializeAppHatchSdk(root);

    expect(await readdir(root)).toEqual(['.hatch']);
    expect((await stat(path.join(root, '.hatch'))).mode & 0o022).toBe(0);
    expect(
      (await stat(path.join(root, HATCH_SDK_IMPORT_MAP))).mode & 0o022,
    ).toBe(0);
    expect((await stat(path.join(root, '.hatch', 'sdk'))).mode & 0o022).toBe(0);
    await expect(
      readFile(
        path.join(appHatchDataPackageDir(root), 'dist', 'data.js'),
        'utf8',
      ),
    ).resolves.toContain('@ts-self-types="./data.d.ts"');
  });

  it('ignores malformed authored Deno configuration', async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, 'deno.json'), '{', 'utf8');

    await materializeAppHatchSdk(root);

    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({ imports: APP_HATCH_SDK_IMPORTS });
  });

  it.each([
    ['regular', tempRoot],
    ['Agent', tempAgentRoot],
  ] as const)(
    'refuses to replace a non-canonical .hatch case variant in a %s root',
    async (_kind, makeRoot) => {
      const root = await makeRoot();
      const managed = path.join(root, '.HATCH');
      const marker = path.join(managed, 'marker');
      await mkdir(managed);
      await writeFile(marker, 'unchanged', 'utf8');

      await expect(materializeAppHatchSdk(root)).rejects.toThrow(
        /non-canonical case variant.*reserved \.hatch directory/i,
      );
      await expect(readFile(marker, 'utf8')).resolves.toBe('unchanged');
      await expect(readdir(root)).resolves.toContain('.HATCH');
    },
  );

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
      await readFile(hatchImportMapPath(root), 'utf8'),
    ) as Record<string, unknown>;
    expect(HATCH_SDK_IMPORT_MAP).toBe('.hatch/import-map.json');
    expect(HATCH_BUF_GEN_CONFIG).toBe('.hatch/buf.gen.yaml');
    expect(importMap).toEqual({ imports: APP_HATCH_SDK_IMPORTS });
    expect(APP_HATCH_SDK_IMPORTS).toEqual({
      '@hatch/data': './sdk/@hatch/data/dist/data.js',
      '@hatch/data/react': './sdk/@hatch/data/dist/data-react.js',
    });
    await expect(
      readFile(path.join(root, HATCH_BUF_GEN_CONFIG), 'utf8'),
    ).resolves.toContain('import_extension=ts');
  });

  it('refreshes stale generated SDK files', async () => {
    const root = await tempRoot();
    await materializeAppHatchSdk(root);
    const generated = path.join(
      appHatchDataPackageDir(root),
      'dist',
      'data.js',
    );
    await Promise.all([
      chmod(generated, 0o644),
      chmod(hatchImportMapPath(root), 0o644),
    ]);
    await writeFile(generated, 'stale', 'utf8');
    await writeFile(hatchImportMapPath(root), 'stale', 'utf8');

    await materializeAppHatchSdk(root);

    await expect(readFile(generated, 'utf8')).resolves.not.toBe('stale');
    await expect(readFile(hatchImportMapPath(root), 'utf8')).resolves.not.toBe(
      'stale',
    );
  });

  it('refreshes an Agent-owned generation with unreadable stale contents', async () => {
    const root = await tempAgentRoot();
    await materializeAppHatchSdk(root);
    const managed = path.join(root, '.hatch');
    await chmod(path.join(managed, 'sdk'), 0o000);
    await chmod(managed, 0o000);

    await expect(materializeAppHatchSdk(root)).resolves.toBeUndefined();

    expect(
      (await readdir(root)).filter(
        (entry) =>
          entry.startsWith('.hatch-install-') ||
          entry.startsWith('.hatch-backup-'),
      ),
    ).toEqual([]);
    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toHaveProperty('imports');
  });

  it('ignores Agent-authored import configuration', async () => {
    const root = await tempAgentRoot();
    await writeFile(
      path.join(root, 'deno.json'),
      JSON.stringify({ imports: { '#local': './local.ts' } }),
      'utf8',
    );

    await materializeAppHatchSdk(root);

    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({ imports: APP_HATCH_SDK_IMPORTS });
  });

  it('provides Deno types without a package or lockfile entry', async () => {
    const root = await tempRoot();
    const denoDir = await tempRoot();
    await mkdir(path.join(root, 'backend'));
    await Promise.all([
      writeFile(
        path.join(root, 'deno.json'),
        JSON.stringify({ allowScripts: [] }),
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
        path.join(root, 'backend', 'check.ts'),
        `
          import { createDataClient, defineSchema, defineTable, t, type JsonValue } from '@hatch/data';
          const schema = defineSchema({ counters: defineTable({ value: t.integer() }) });
          const data = createDataClient<typeof schema>({ baseUrl: 'http://hatch.test' });
          const metadata: JsonValue = { source: 'test' };
          await data.increment('counters', 'counter-1', 'value', 1);
          console.log(metadata);
        `,
        'utf8',
      ),
    ]);
    await materializeAppHatchSdk(root);

    await expect(
      exec(
        'deno',
        [
          'check',
          '--node-modules-dir=auto',
          `--import-map=${HATCH_SDK_IMPORT_MAP}`,
          '--lock=deno.lock',
          '--frozen',
          'backend/check.ts',
        ],
        { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
      ),
    ).resolves.toBeDefined();
    const importMap = JSON.parse(
      await readFile(hatchImportMapPath(root), 'utf8'),
    );
    expect(importMap).toEqual({ imports: APP_HATCH_SDK_IMPORTS });
    const lock = await readFile(path.join(root, 'deno.lock'), 'utf8');
    expect(lock).not.toContain('@hatch/data');
  });

  it('replaces an untrusted nested package symlink without touching its target', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(path.dirname(appHatchDataPackageDir(root)), {
      recursive: true,
    });
    const marker = path.join(outside, 'marker');
    await writeFile(marker, 'keep me', 'utf8');
    await symlink(outside, appHatchDataPackageDir(root));

    await materializeAppHatchSdk(root);

    await expect(readFile(marker, 'utf8')).resolves.toBe('keep me');
    await expect(
      readFile(path.join(appHatchDataPackageDir(root), 'package.json'), 'utf8'),
    ).resolves.toContain('"name": "@hatch/data"');
  });

  it('replaces an untrusted import map symlink without touching its target', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await mkdir(path.dirname(hatchImportMapPath(root)), { recursive: true });
    const target = path.join(outside, 'import-map.json');
    await writeFile(target, 'keep me', 'utf8');
    await symlink(target, hatchImportMapPath(root));

    await materializeAppHatchSdk(root);

    await expect(readFile(target, 'utf8')).resolves.toBe('keep me');
    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({ imports: APP_HATCH_SDK_IMPORTS });
  });

  it('refuses a symlinked platform directory', async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await symlink(outside, path.join(root, '.hatch'));

    await expect(materializeAppHatchSdk(root)).rejects.toThrow(
      'platform-owned Hatch SDK: .hatch is a symbolic link',
    );
    await expect(
      readFile(
        path.join(outside, 'sdk', '@hatch', 'data', 'package.json'),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Workflow Hatch SDK materialization', () => {
  it('creates a versionless package and workflow-only import map', async () => {
    const root = await tempRoot();

    await materializeWorkflowHatchSdk(root);

    const packageDir = workflowHatchPackageDir(root);
    const manifest = JSON.parse(
      await readFile(path.join(packageDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: '@hatch/workflow',
      private: true,
      type: 'module',
    });
    expect(manifest).not.toHaveProperty('version');
    await expect(
      readFile(path.join(packageDir, 'dist', 'workflow.js'), 'utf8'),
    ).resolves.toContain('function defineWorkflow');
    await expect(
      readFile(path.join(packageDir, 'dist', 'workflow.d.ts'), 'utf8'),
    ).resolves.toContain('export declare function defineWorkflow');
    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({ imports: WORKFLOW_HATCH_SDK_IMPORTS });
    expect(WORKFLOW_HATCH_SDK_IMPORTS).toEqual({
      '@hatch/workflow': './sdk/@hatch/workflow/dist/workflow.js',
    });
    await expect(
      readFile(path.join(root, HATCH_BUF_GEN_CONFIG), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refreshes an Agent-owned generation without trusting stale SDK bytes', async () => {
    const root = await tempAgentRoot();
    await materializeWorkflowHatchSdk(root);
    const generated = path.join(
      workflowHatchPackageDir(root),
      'dist',
      'workflow.js',
    );
    await writeFile(generated, 'stale', 'utf8');

    await materializeWorkflowHatchSdk(root);

    await expect(readFile(generated, 'utf8')).resolves.not.toBe('stale');
    await expect(
      readFile(hatchImportMapPath(root), 'utf8').then(JSON.parse),
    ).resolves.toEqual({ imports: WORKFLOW_HATCH_SDK_IMPORTS });
  });

  it('provides inferred Workflow types through the generated import map', async () => {
    const root = await tempRoot();
    const denoDir = await tempRoot();
    const templateDir = path.resolve('templates/default-workflow');
    await Promise.all([
      ...['package.json', 'deno.json', 'deno.lock'].map((file) =>
        copyFile(path.join(templateDir, file), path.join(root, file)),
      ),
      writeFile(
        path.join(root, 'workflow.ts'),
        `
          import { defineWorkflow } from '@hatch/workflow';
          import { z } from 'zod';
          export default defineWorkflow({
            input: z.object({ count: z.number() }),
            run: async (ctx, input) => {
              await ctx.step('format', () => input.count.toFixed(2));
              // @ts-expect-error The generated SDK must infer the zod input.
              input.missing;
              return { count: input.count };
            },
          });
        `,
        'utf8',
      ),
    ]);
    await materializeWorkflowHatchSdk(root);

    await expect(
      exec(
        'deno',
        [
          'check',
          '--node-modules-dir=auto',
          `--import-map=${HATCH_SDK_IMPORT_MAP}`,
          '--lock=deno.lock',
          '--frozen',
          'workflow.ts',
        ],
        { cwd: root, env: { ...process.env, DENO_DIR: denoDir } },
      ),
    ).resolves.toBeDefined();
    await expect(
      readFile(
        path.join(workflowHatchPackageDir(root), 'dist', 'workflow.js'),
        'utf8',
      ),
    ).resolves.toContain('@ts-self-types="./workflow.d.ts"');
    const lock = await readFile(path.join(root, 'deno.lock'), 'utf8');
    expect(lock).not.toContain('@hatch/workflow');
  });
});
