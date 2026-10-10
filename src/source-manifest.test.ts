import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  materializeAppHatchSdk,
  materializeWorkflowHatchSdk,
} from './agent/hatch-sdk';
import { loadSourceManifest, manifestRunner } from './source-manifest';
import { parseSourceManifest } from './server/apps/manifest';
import { parseSourceWorkflowManifest } from './server/workflows/manifest';

let root: string;
const app = {
  id: 'demo',
  name: 'Demo',
  capabilities: { frontend: true },
  app: { entry: 'app/main.tsx' },
};
const workflow = {
  id: 'demo',
  name: 'Demo',
  compatibilityVersion: 1,
  network: [],
};
const loadApp = (evaluationTimeoutMs?: number) =>
  loadSourceManifest(root, {
    kind: 'app',
    parse: parseSourceManifest,
    evaluationTimeoutMs,
  });
const loadWorkflow = () =>
  loadSourceManifest(root, {
    kind: 'workflow',
    parse: parseSourceWorkflowManifest,
  });
const write = (source: string) =>
  fs.writeFile(path.join(root, 'manifest.ts'), source);
const defined = (value: unknown) =>
  `import { defineAppManifest } from '@hatch/app';\nexport default defineAppManifest(${JSON.stringify(value)});`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-contract-'));
  for (const file of ['package.json', 'deno.json', 'deno.lock']) {
    await fs.copyFile(
      path.resolve('templates/default-workflow', file),
      path.join(root, file),
    );
  }
  const installed = await manifestRunner(root)(
    [
      'install',
      '--package-json',
      '--node-modules-dir=auto',
      '--lock=deno.lock',
      '--frozen',
    ],
    {},
  );
  if (installed.code !== 0) throw new Error(installed.output);
  await materializeAppHatchSdk(root);
}, 60_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(root, 'manifest.ts'), { force: true });
  await fs.rm(path.join(root, 'manifest.json'), { force: true });
});

describe.sequential('source manifest contract', () => {
  it('resolves the shipped SDK types and produces the same JSON contract from TS and JSON', async () => {
    await write(defined(app));
    const ts = await loadApp();
    await fs.rm(path.join(root, 'manifest.ts'));
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(app));
    const json = await loadApp();
    expect(ts.manifest).toEqual(json.manifest);
    expect(ts.manifest).toMatchObject({
      backendMode: 'serverless',
      app: { routes: [] },
    });
    await fs.rm(path.join(root, 'manifest.json'));
  });

  it('checks manifest-only types and supports satisfies with local constants', async () => {
    await fs.writeFile(
      path.join(root, 'constants.ts'),
      "export const name = 'Shared name';",
    );
    await write(
      `import type { AppManifestInput } from '@hatch/app';\nimport { name } from './constants.ts';\nexport default { id: 'demo', name, capabilities: {} } satisfies AppManifestInput;`,
    );
    expect((await loadApp()).manifest.name).toBe('Shared name');
    await write(defined({ ...app, name: 42 }));
    await expect(loadApp()).rejects.toThrow(/not assignable/);
  });

  it('rejects ambiguous files before executing TS and never falls back from a broken TS manifest', async () => {
    await write('throw new Error("must not execute"); export default {};');
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(app));
    await expect(loadApp()).rejects.toThrow(/not both/);
    await fs.rm(path.join(root, 'manifest.json'));
    await expect(loadApp()).rejects.toThrow(/must not execute/);
  });

  it('retains runtime cross-field validation even without a helper', async () => {
    await write(
      "export default { id: 'demo', name: 'Demo', capabilities: { frontend: true } };",
    );
    await expect(loadApp()).rejects.toThrow(/app.entry/);
  });

  it('rejects values that JSON.stringify would discard or transform', async () => {
    for (const value of [
      'undefined',
      'NaN',
      '1n',
      'new Date()',
      '() => 1',
      'Promise.resolve({})',
    ]) {
      await write(
        `export default { id: 'demo', name: 'Demo', capabilities: {}, invalid: ${value} };`,
      );
      await expect(loadApp()).rejects.toThrow(/JSON/);
    }
    await write(
      'const value: Record<string, unknown> = {}; value.self = value; export default value;',
    );
    await expect(loadApp()).rejects.toThrow(/circular reference/);
  }, 60_000);

  it('denies executable configuration access to host resources', async () => {
    for (const operation of [
      "Deno.env.get('DATABASE_URL')",
      "fetch('http://127.0.0.1:45122')",
      "Deno.writeTextFile('unexpected.txt', 'bad')",
      "new Deno.Command('sh', { args: ['-c', 'true'] }).output()",
    ]) {
      await write(`await ${operation}; export default ${JSON.stringify(app)};`);
      await expect(loadApp()).rejects.toThrow(/Requires|NotCapable/);
    }
    await expect(fs.access(path.join(root, 'unexpected.txt'))).rejects.toThrow(
      /ENOENT/,
    );
  }, 60_000);

  it('rejects imports outside the source tree before evaluating them', async () => {
    const outside = path.join(
      path.dirname(root),
      `${path.basename(root)}-outside.ts`,
    );
    await fs.writeFile(outside, "export const name = 'outside';");
    try {
      await write(
        `import { name } from ${JSON.stringify(outside)}; export default { id: 'demo', name, capabilities: {} };`,
      );
      await expect(loadApp()).rejects.toThrow(/escapes source root/);
      await write(
        `import type { name } from ${JSON.stringify(outside)}; export default { id: 'demo', name: 'Demo', capabilities: {} };`,
      );
      await expect(loadApp()).rejects.toThrow(/escapes source root/);
      await fs.symlink(outside, path.join(root, 'linked.ts'));
      await write(
        "import { name } from './linked.ts'; export default { id: 'demo', name, capabilities: {} };",
      );
      await expect(loadApp()).rejects.toThrow(/escapes source root|symbolic/);
      await fs.rm(path.join(root, 'linked.ts'));
    } finally {
      await fs.rm(outside);
    }
  });

  it('terminates a hung evaluation and refuses spoofed result records', async () => {
    await write(`while (true) {} export default ${JSON.stringify(app)};`);
    await expect(loadApp(100)).rejects.toThrow(/timed out/);
    await write(
      `console.log('[[hatch-manifest]]{}'); export default ${JSON.stringify(app)};`,
    );
    await expect(loadApp()).rejects.toThrow(/exactly one result/);
  });

  it('bounds excessive output and supports cancellation during evaluation', async () => {
    await write(
      `console.log('x'.repeat(1_100_000)); export default ${JSON.stringify(app)};`,
    );
    await expect(loadApp()).rejects.toThrow(/output exceeded the 1 MB limit/);
    await write(`while (true) {} export default ${JSON.stringify(app)};`);
    const controller = new AbortController();
    const execute = manifestRunner(root, { signal: controller.signal });
    await expect(
      loadSourceManifest(root, {
        kind: 'app',
        parse: parseSourceManifest,
        run: async (args, extra) => {
          const timer =
            args[0] === 'run'
              ? setTimeout(() => controller.abort(), 100)
              : undefined;
          try {
            return await execute(args, extra);
          } finally {
            clearTimeout(timer);
          }
        },
      }),
    ).rejects.toThrow(/aborted/);
  });

  it('cannot load runtime-computed external modules or remote static modules', async () => {
    await write(
      `const file = '/tmp/manifest-forbidden.ts'; await import(file); export default ${JSON.stringify(app)};`,
    );
    await expect(loadApp()).rejects.toThrow(
      /Requires read access|external imports/,
    );
    await write(
      `import 'https://example.com/manifest.ts'; export default ${JSON.stringify(app)};`,
    );
    await expect(loadApp()).rejects.toThrow(
      /Requires import access|remote|https|Unsupported/,
    );
  });

  it('gives Workflow the same capability without defaulting its required compatibility version', async () => {
    await materializeWorkflowHatchSdk(root);
    const source = `import { defineWorkflowManifest } from '@hatch/workflow/manifest';\nexport default defineWorkflowManifest(${JSON.stringify(workflow)});`;
    await write(source);
    expect((await loadWorkflow()).manifest).toEqual(
      parseSourceWorkflowManifest(workflow),
    );
    await write(source.replace('"compatibilityVersion":1,', ''));
    await expect(loadWorkflow()).rejects.toThrow(/compatibilityVersion/);
    await fs.rm(path.join(root, 'manifest.ts'));
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify(workflow),
    );
    expect((await loadWorkflow()).manifest).toEqual(
      parseSourceWorkflowManifest(workflow),
    );
  });
});
