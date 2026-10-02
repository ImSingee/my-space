import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflow } from './build';

const tempDirs: string[] = [];

async function makeWorkflowSource(options?: {
  network?: unknown;
  workflowSource?: string;
}): Promise<{
  sourceDir: string;
  outputDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-workflow-test-'));
  tempDirs.push(root);
  const sourceDir = path.join(root, 'src');
  const outputDir = path.join(root, 'out');
  const templateDir = path.resolve('templates/default-workflow');
  await fs.mkdir(path.join(sourceDir, '.HATCH'), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(sourceDir, 'manifest.json'),
      JSON.stringify({
        id: 'demo',
        name: 'Demo',
        compatibilityVersion: 1,
        entry: 'workflow.ts',
        ...(options && Object.hasOwn(options, 'network')
          ? { network: options.network }
          : {}),
        triggers: { cron: [], webhook: false },
      }),
      'utf8',
    ),
    ...['package.json', 'deno.json', 'deno.lock'].map((file) =>
      fs.copyFile(path.join(templateDir, file), path.join(sourceDir, file)),
    ),
    fs.writeFile(
      path.join(sourceDir, 'workflow.ts'),
      options?.workflowSource ??
        "import { defineWorkflow } from '@hatch/workflow';\n" +
          "import { z } from 'zod';\n" +
          'export default defineWorkflow({\n' +
          '  input: z.object({ name: z.string() }),\n' +
          '  run: (_ctx, input) => ({ greeting: `Hello, ${input.name}!` }),\n' +
          '});\n',
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, '.HATCH', 'import-map.json'),
      JSON.stringify({
        imports: { '@hatch/workflow': './attacker-controlled.ts' },
      }),
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, '.HATCH', 'attacker-controlled.ts'),
      'throw new Error("untrusted SDK executed");\n',
      'utf8',
    ),
  ]);
  return { sourceDir, outputDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('buildWorkflow dependencies', () => {
  it('builds a typed manifest and preserves a previous artifact on validation failure', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource({ network: [] });
    const json = await fs.readFile(
      path.join(sourceDir, 'manifest.json'),
      'utf8',
    );
    await fs.rm(path.join(sourceDir, 'manifest.json'));
    const typed = `import { defineWorkflowManifest } from '@hatch/workflow/manifest';\nexport default defineWorkflowManifest(${json});`;
    await fs.writeFile(path.join(sourceDir, 'manifest.ts'), typed);
    const built = await buildWorkflow('demo', { sourceDir, outputDir });
    const before = await fs.readFile(built.bundlePath, 'utf8');
    expect(built.source.compatibilityVersion).toBe(1);
    expect(built.inputSchema).toMatchObject({ type: 'object' });
    await fs.writeFile(
      path.join(sourceDir, 'manifest.ts'),
      typed.replace(
        '"compatibilityVersion":1',
        '"compatibilityVersion":"invalid"',
      ),
    );
    await expect(
      buildWorkflow('demo', { sourceDir, outputDir }),
    ).rejects.toThrow(/not assignable/);
    expect(await fs.readFile(built.bundlePath, 'utf8')).toBe(before);
  });

  it('installs a frozen package.json graph and injects the SDK import map', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource();

    const result = await buildWorkflow('demo', { sourceDir, outputDir });

    await expect(fs.access(result.bundlePath)).resolves.toBeUndefined();
    expect(result.inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(result.log).toContain(
      'deno install --package-json --node-modules-dir=auto --lock=deno.lock --frozen',
    );
    expect(result.log).toContain('--import-map');
    await expect(fs.readFile(result.bundlePath, 'utf8')).resolves.not.toContain(
      'untrusted SDK executed',
    );
  });

  it('rejects the retired source-owned hatch/workflow.ts SDK', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource();
    const legacyDir = path.join(sourceDir, 'hatch');
    await fs.mkdir(legacyDir);
    await fs.writeFile(
      path.join(legacyDir, 'workflow.ts'),
      'export const legacy = true;\n',
      'utf8',
    );

    await expect(
      buildWorkflow('demo', { sourceDir, outputDir }),
    ).rejects.toThrow(/retired hatch\/workflow\.ts SDK/);
  });

  it('persists the network policy used while describing the bundle', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource({ network: [] });

    const result = await buildWorkflow('demo', { sourceDir, outputDir });

    expect(result.normalized.network).toEqual([]);
    await expect(
      fs.readFile(path.join(outputDir, 'manifest.normalized.json'), 'utf8'),
    ).resolves.toContain('"network": []');
  });

  it('enforces the declared policy while describing author code', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource({
      network: [],
      workflowSource:
        "import { defineWorkflow } from '@hatch/workflow';\n" +
        "await fetch('http://127.0.0.1:45122');\n" +
        'export default defineWorkflow({ run: () => ({ ok: true }) });\n',
    });

    await expect(
      buildWorkflow('demo', { sourceDir, outputDir }),
    ).rejects.toThrow(/Requires net access/);
  });
});
