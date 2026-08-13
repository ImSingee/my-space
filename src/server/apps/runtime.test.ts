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
  ensureAppDatabase: vi.fn<() => Promise<{ url: string }>>(),
}));

const { backendArtifactEnv, buildBackendDenoArgs, resolveBackendArtifact } =
  await import('./runtime');

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
  it('reads bundle-v1 metadata with a custom nested entry', () => {
    const bundleDir = runtimeDir();
    const bundleEntry = writeBackendEntry(
      bundleDir,
      'backend/workers/server.bundle.js',
    );

    writeManifest(bundleDir, {
      backend: {
        entry: 'backend/workers/server.bundle.js',
        format: 'bundle-v1',
      },
    });

    expect(resolveBackendArtifact(bundleDir)).toEqual({
      entryPath: bundleEntry,
    });
  });

  it('rejects a missing manifest or missing backend metadata', () => {
    const missingManifestDir = runtimeDir();
    const missingBackendDir = runtimeDir();
    writeManifest(missingBackendDir, { capabilities: { backend: true } });

    expect(() => resolveBackendArtifact(missingManifestDir)).toThrow(
      /manifest\.normalized\.json does not exist/,
    );
    expect(() => resolveBackendArtifact(missingBackendDir)).toThrow(
      /backend metadata is missing/,
    );
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
      'missing format',
      JSON.stringify({ backend: { entry: 'backend/main.bundle.js' } }),
      /backend\.format must be "bundle-v1"/,
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
  ])('rejects %s', (_label, raw, expected) => {
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
    writeManifest(dir, { backend: { entry, format: 'bundle-v1' } });

    expect(() => resolveBackendArtifact(dir)).toThrow(
      /relative path inside "backend\/"/,
    );
  });

  it('rejects missing entries and entries that are not regular files', () => {
    const missingDir = runtimeDir();
    const directoryDir = runtimeDir();
    writeManifest(missingDir, {
      backend: { entry: 'backend/missing.bundle.js', format: 'bundle-v1' },
    });
    mkdirSync(path.join(directoryDir, 'backend', 'directory'), {
      recursive: true,
    });
    writeManifest(directoryDir, {
      backend: { entry: 'backend/directory', format: 'bundle-v1' },
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
    writeManifest(directDir, {
      backend: { entry: 'backend/linked.ts', format: 'bundle-v1' },
    });

    const nestedTarget = path.join(nestedDir, 'outside');
    mkdirSync(nestedTarget);
    writeFileSync(path.join(nestedTarget, 'main.ts'), '// outside\n', 'utf8');
    mkdirSync(path.join(nestedDir, 'backend'));
    symlinkSync(nestedTarget, path.join(nestedDir, 'backend', 'linked'));
    writeManifest(nestedDir, {
      backend: {
        entry: 'backend/linked/main.ts',
        format: 'bundle-v1',
      },
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

  it('injects the fixed assets directory', () => {
    expect(backendArtifactEnv('/build')).toEqual({
      HATCH_ASSETS_DIR: '/build/backend/assets',
    });
  });

  it('runs bundles without config or dependency resolution', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
      },
      buildDir: '/build',
      storageDir: '/storage',
      certPaths: ['/tls/ca.pem'],
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
