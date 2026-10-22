import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({ foreignRoot: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    // Inject only the device boundary; staging, replacement and cleanup still
    // use real files. This covers hosts without a second writable filesystem.
    lstat: async (
      target: Parameters<typeof original.lstat>[0],
      options: Parameters<typeof original.lstat>[1],
    ) => {
      const entry = await original.lstat(target, options);
      if (target === filesystem.foreignRoot) {
        entry.dev =
          typeof entry.dev === 'bigint' ? entry.dev + 1n : entry.dev + 1;
      }
      return entry;
    },
  };
});

const testDataRoot = await mkdtemp(
  path.join(os.tmpdir(), 'hatch-sdk-filesystem-'),
);
vi.stubEnv('HATCH_DATA_DIR', testDataRoot);
const { materializeAppHatchSdk, materializeWorkflowHatchSdk } =
  await import('./hatch-sdk');
const { HATCH_SDK_STAGING_DIR } = await import('./paths');

afterEach(() => {
  filesystem.foreignRoot = '';
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(testDataRoot, { recursive: true, force: true });
});

describe('Hatch SDK filesystem boundary', () => {
  it.each([
    ['App', materializeAppHatchSdk],
    ['Workflow', materializeWorkflowHatchSdk],
  ] as const)(
    'preserves the installed %s generation and cleans staging when devices differ',
    async (_kind, materialize) => {
      const root = await mkdtemp(path.join(testDataRoot, 'source-'));
      await materialize(root);
      const importMap = path.join(root, '.hatch', 'import-map.json');
      const previous = await readFile(importMap, 'utf8');
      const marker = path.join(root, '.hatch', 'previous-generation');
      await writeFile(marker, 'keep');

      filesystem.foreignRoot = root;

      await expect(materialize(root)).rejects.toThrow(
        'cannot be atomically installed across filesystems',
      );
      await expect(readFile(importMap, 'utf8')).resolves.toBe(previous);
      await expect(readFile(marker, 'utf8')).resolves.toBe('keep');
      await expect(readdir(root)).resolves.toEqual(['.hatch']);
      await expect(readdir(HATCH_SDK_STAGING_DIR)).resolves.toEqual([]);
    },
  );
});
