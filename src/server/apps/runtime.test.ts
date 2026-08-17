import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', () => ({ db: {}, schema: {} }));
vi.mock('./provision', () => ({
  resolveAppDatabaseUrl: vi.fn<() => Promise<string>>(),
}));

const {
  backendArtifactEnv,
  backendStorageEnv,
  buildBackendDenoArgs,
  resolveBackendArtifact,
} = await import('./runtime');

const tempDirs: string[] = [];

function runtimeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hatch-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function writeBackendEntry(root: string, entry: string): string {
  const entryPath = path.resolve(root, ...entry.split('/'));
  mkdirSync(path.dirname(entryPath), { recursive: true });
  writeFileSync(entryPath, '// backend entry\n', 'utf8');
  return entryPath;
}

function writeManifest(root: string, value: unknown): void {
  writeFileSync(
    path.join(root, 'manifest.normalized.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('app backend runtime artifacts', () => {
  it('reads bundle-v1 metadata and keeps legacy manifests source-based', () => {
    const bundleDir = runtimeDir();
    const legacyDir = runtimeDir();
    const bundleEntry = writeBackendEntry(bundleDir, 'backend/main.bundle.js');
    const legacyEntry = writeBackendEntry(legacyDir, 'backend/server.ts');

    writeManifest(bundleDir, {
      backend: { entry: 'backend/main.bundle.js', format: 'bundle-v1' },
    });
    writeManifest(legacyDir, {
      backend: { entry: 'backend/server.ts' },
    });

    expect(resolveBackendArtifact(bundleDir)).toEqual({
      entryPath: bundleEntry,
      format: 'bundle-v1',
    });
    expect(resolveBackendArtifact(legacyDir)).toEqual({
      entryPath: legacyEntry,
    });
  });

  it('keeps the legacy default when old manifests omit backend metadata', () => {
    const missingManifestDir = runtimeDir();
    const oldManifestDir = runtimeDir();
    const oldManifestEntry = writeBackendEntry(
      oldManifestDir,
      'backend/main.ts',
    );
    writeManifest(oldManifestDir, { capabilities: { backend: true } });

    expect(() => resolveBackendArtifact(missingManifestDir)).toThrow(
      /manifest\.normalized\.json does not exist/,
    );
    expect(resolveBackendArtifact(oldManifestDir)).toEqual({
      entryPath: oldManifestEntry,
    });
  });

  it.each([
    ['malformed JSON', '{', /not valid JSON/],
    ['non-object manifest', '[]', /must contain an object/],
    [
      'invalid backend metadata',
      JSON.stringify({ backend: null }),
      /backend metadata must be an object/,
    ],
    [
      'unknown format',
      JSON.stringify({
        backend: { entry: 'backend/main.js', format: 'bundle-v2' },
      }),
      /unsupported backend format.*bundle-v2/,
    ],
    [
      'backend metadata without an entry',
      JSON.stringify({ backend: {} }),
      /backend\.entry must be a non-empty string/,
    ],
    [
      'bundle without an entry',
      JSON.stringify({ backend: { format: 'bundle-v1' } }),
      /backend\.entry must be a non-empty string/,
    ],
  ])('rejects %s instead of treating it as legacy', (_label, raw, expected) => {
    const dir = runtimeDir();
    writeManifest(dir, raw);

    expect(() => resolveBackendArtifact(dir)).toThrow(expected);
  });

  it.each([
    '../outside.ts',
    '/tmp/outside.ts',
    'app/main.ts',
    'backend/../outside.ts',
    'backend\\main.ts',
  ])('rejects an unsafe backend entry path: %s', (entry) => {
    const dir = runtimeDir();
    writeManifest(dir, { backend: { entry } });

    expect(() => resolveBackendArtifact(dir)).toThrow(
      /relative path inside "backend\/"/,
    );
  });

  it('rejects missing entries and entries that are not regular files', () => {
    const missingDir = runtimeDir();
    const directoryDir = runtimeDir();
    writeManifest(missingDir, {
      backend: { entry: 'backend/missing.ts' },
    });
    mkdirSync(path.join(directoryDir, 'backend', 'directory'), {
      recursive: true,
    });
    writeManifest(directoryDir, {
      backend: { entry: 'backend/directory' },
    });

    expect(() => resolveBackendArtifact(missingDir)).toThrow(/does not exist/);
    expect(() => resolveBackendArtifact(directoryDir)).toThrow(
      /not a regular file/,
    );
  });

  it('rejects symbolic links in the backend entry path', () => {
    const directDir = runtimeDir();
    const nestedDir = runtimeDir();
    const directTarget = writeBackendEntry(directDir, 'backend/target.ts');
    symlinkSync(directTarget, path.join(directDir, 'backend', 'linked.ts'));
    writeManifest(directDir, { backend: { entry: 'backend/linked.ts' } });

    const nestedTarget = path.join(nestedDir, 'outside');
    mkdirSync(nestedTarget);
    writeFileSync(path.join(nestedTarget, 'main.ts'), '// outside\n', 'utf8');
    mkdirSync(path.join(nestedDir, 'backend'));
    symlinkSync(nestedTarget, path.join(nestedDir, 'backend', 'linked'));
    writeManifest(nestedDir, {
      backend: { entry: 'backend/linked/main.ts' },
    });

    expect(() => resolveBackendArtifact(directDir)).toThrow(/symbolic links/);
    expect(() => resolveBackendArtifact(nestedDir)).toThrow(/symbolic links/);
  });

  it('rejects a symbolic normalized manifest', () => {
    const dir = runtimeDir();
    writeBackendEntry(dir, 'backend/main.ts');
    const target = path.join(dir, 'real-manifest.json');
    writeFileSync(target, JSON.stringify({ backend: {} }), 'utf8');
    symlinkSync(target, path.join(dir, 'manifest.normalized.json'));

    expect(() => resolveBackendArtifact(dir)).toThrow(
      /manifest\.normalized\.json must be a regular file/,
    );
  });

  it('retains the legacy source invocation and cache access', () => {
    expect(
      buildBackendDenoArgs({
        artifact: { entryPath: '/build/backend/main.ts' },
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
      '/build/backend/main.ts',
    ]);
  });

  it('withholds storage environment and filesystem permissions when disabled', () => {
    const legacyArgs = buildBackendDenoArgs({
      artifact: { entryPath: '/build/backend/main.ts' },
      buildDir: '/build',
      storageDir: null,
      cacheDir: '/deno-cache',
      certPaths: ['/tls/ca.pem'],
      hasLock: true,
    });
    const bundledArgs = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
      },
      buildDir: '/build',
      storageDir: null,
      cacheDir: '/deno-cache',
      certPaths: ['/tls/ca.pem'],
      hasLock: true,
    });

    expect(legacyArgs).toContain('--allow-read=/build,/deno-cache,/tls/ca.pem');
    expect(bundledArgs).toContain(
      '--allow-read=/build/backend/assets,/tls/ca.pem',
    );
    expect(legacyArgs.some((arg) => arg.startsWith('--allow-write='))).toBe(
      false,
    );
    expect(bundledArgs.some((arg) => arg.startsWith('--allow-write='))).toBe(
      false,
    );
    expect(backendStorageEnv(null)).toEqual({});
    expect(backendStorageEnv('/storage')).toEqual({
      STORAGE_DIR: '/storage',
    });
  });

  it('injects the fixed assets directory only for bundle-v1', () => {
    expect(
      backendArtifactEnv('/build', {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
      }),
    ).toEqual({ HATCH_ASSETS_DIR: '/build/backend/assets' });
    expect(
      backendArtifactEnv('/build', {
        entryPath: '/build/backend/main.ts',
      }),
    ).toEqual({});
  });

  it('runs bundle-v1 without config, dependency resolution, or cache access', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
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
      '/build/backend/main.bundle.js',
    ]);
    expect(args.join(' ')).not.toContain('/deno-cache');
    expect(args).not.toContain('--node-modules-dir=none');
    expect(args).not.toContain('--lock=deno.lock');
    expect(args).not.toContain('--frozen');
  });
});
