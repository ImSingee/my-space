import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './build';

const tempDirs: string[] = [];

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
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(sourceDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return { sourceDir, outputDir };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
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
