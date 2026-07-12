import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflow } from './build';

const tempDirs: string[] = [];

async function makeWorkflowSource(): Promise<{
  sourceDir: string;
  outputDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-workflow-test-'));
  tempDirs.push(root);
  const sourceDir = path.join(root, 'src');
  const outputDir = path.join(root, 'out');
  await fs.mkdir(path.join(sourceDir, 'hatch'), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(sourceDir, 'manifest.json'),
      JSON.stringify({
        id: 'demo',
        name: 'Demo',
        entry: 'workflow.ts',
        triggers: { cron: [], webhook: false },
      }),
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, 'deno.json'),
      JSON.stringify({
        imports: { '@hatch/workflow': './hatch/workflow.ts' },
        allowScripts: [],
      }),
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, 'deno.lock'),
      JSON.stringify({
        version: '5',
        specifiers: {},
        npm: {},
        workspace: { packageJson: { dependencies: [] } },
      }),
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, 'workflow.ts'),
      "import { defineWorkflow } from '@hatch/workflow';\n" +
        'export default defineWorkflow({ run: () => ({ ok: true }) });\n',
      'utf8',
    ),
    fs.writeFile(
      path.join(sourceDir, 'hatch', 'workflow.ts'),
      'export function defineWorkflow<T>(workflow: T): T { return workflow; }\n' +
        'export async function runCli(): Promise<void> {\n' +
        "  if (Deno.env.get('HATCH_MODE') === 'describe') {\n" +
        "    console.log('[[hatch]]' + JSON.stringify({ t: 'schema', schema: { type: 'object' } }));\n" +
        '  }\n' +
        '}\n',
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
  it('installs a frozen package.json graph and injects the SDK import map', async () => {
    const { sourceDir, outputDir } = await makeWorkflowSource();

    const result = await buildWorkflow('demo', { sourceDir, outputDir });

    await expect(fs.access(result.bundlePath)).resolves.toBeUndefined();
    expect(result.inputSchema).toEqual({ type: 'object' });
    expect(result.log).toContain(
      'deno install --package-json --node-modules-dir=auto --lock=deno.lock --frozen',
    );
    expect(result.log).toContain('--import-map');
  });
});
