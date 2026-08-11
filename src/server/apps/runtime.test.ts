import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', () => ({ db: {}, schema: {} }));
vi.mock('./provision', () => ({
  ensureAppDatabase: vi.fn<() => Promise<{ url: string }>>(),
}));

const { backendArtifactEnv, buildBackendDenoArgs, resolveBackendArtifact } =
  await import('./runtime');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('app backend runtime artifacts', () => {
  it('reads bundle-v1 metadata and keeps legacy manifests source-based', () => {
    const bundleDir = mkdtempSync(path.join(os.tmpdir(), 'hatch-runtime-'));
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'hatch-runtime-'));
    tempDirs.push(bundleDir, legacyDir);

    writeFileSync(
      path.join(bundleDir, 'manifest.normalized.json'),
      JSON.stringify({
        backend: { entry: 'backend/main.bundle.js', format: 'bundle-v1' },
      }),
    );
    writeFileSync(
      path.join(legacyDir, 'manifest.normalized.json'),
      JSON.stringify({ backend: { entry: 'backend/server.ts' } }),
    );

    expect(resolveBackendArtifact(bundleDir)).toEqual({
      entry: 'backend/main.bundle.js',
      format: 'bundle-v1',
    });
    expect(resolveBackendArtifact(legacyDir)).toEqual({
      entry: 'backend/server.ts',
    });
  });

  it('retains the legacy source invocation and cache access', () => {
    expect(
      buildBackendDenoArgs({
        artifact: { entry: 'backend/main.ts' },
        buildDir: '/build',
        storageDir: '/storage',
        cacheDir: '/deno-cache',
        certPaths: ['/tls/ca.pem'],
        hasLock: true,
      }),
    ).toEqual([
      'run',
      '--node-modules-dir=none',
      '--allow-read=/build,/storage,/deno-cache,/tls/ca.pem',
      '--allow-write=/storage',
      '--allow-net',
      '--allow-env',
      '--no-prompt',
      '--lock=deno.lock',
      '--frozen',
      'backend/main.ts',
    ]);
  });

  it('injects the fixed assets directory only for bundle-v1', () => {
    expect(
      backendArtifactEnv('/build', {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
      }),
    ).toEqual({ HATCH_ASSETS_DIR: '/build/backend/assets' });
    expect(backendArtifactEnv('/build', { entry: 'backend/main.ts' })).toEqual(
      {},
    );
  });

  it('runs bundle-v1 without config, dependency resolution, or cache access', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
      },
      buildDir: '/build',
      storageDir: '/storage',
      cacheDir: '/deno-cache',
      certPaths: ['/tls/ca.pem'],
      hasLock: true,
    });

    expect(args).toEqual([
      'run',
      '--no-config',
      '--no-lock',
      '--no-npm',
      '--no-remote',
      '--cached-only',
      '--allow-read=/build/backend/assets,/storage,/tls/ca.pem',
      '--allow-write=/storage',
      '--allow-net',
      '--allow-env',
      '--no-prompt',
      'backend/main.bundle.js',
    ]);
    expect(args.join(' ')).not.toContain('/deno-cache');
    expect(args).not.toContain('--node-modules-dir=none');
    expect(args).not.toContain('--lock=deno.lock');
    expect(args).not.toContain('--frozen');
  });
});
