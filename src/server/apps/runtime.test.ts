import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<
    () => Promise<
      | {
          status: 'deployed';
          capabilities: { backend: true };
          currentDeploymentId: string;
        }
      | undefined
    >
  >(),
  findDeployment:
    vi.fn<() => Promise<{ compatibilityVersion: number | null } | undefined>>(),
  resolveAppDatabaseUrl: vi.fn<() => Promise<string>>(),
}));

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: { findFirst: mocks.findDeployment },
    },
  },
  schema: {},
}));
vi.mock('./provision', () => ({
  resolveAppDatabaseUrl: mocks.resolveAppDatabaseUrl,
}));

const {
  backendArtifactEnv,
  backendPortEnv,
  backendStorageEnv,
  buildBackendDenoArgs,
  ensureAppRunning,
  getBackendRuntimeView,
  resolveBackendArtifact,
  setKeepAlive,
  startAppBackend,
} = await import('./runtime');

const tempDirs: string[] = [];
const KEEP_ALIVE_APP_ID = 'keep-alive-app';
const KEEP_ALIVE_DEPLOYMENT_ID = 'keep-alive-deployment';

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
  setKeepAlive(KEEP_ALIVE_APP_ID, false);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('long-running backend compatibility checks', () => {
  beforeEach(() => {
    mocks.findApp.mockReset();
    mocks.findDeployment.mockReset();
    mocks.resolveAppDatabaseUrl.mockReset();
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      capabilities: { backend: true },
      currentDeploymentId: KEEP_ALIVE_DEPLOYMENT_ID,
    });
  });

  it('preserves keep-alive on transient reads and clears confirmed blocks', async () => {
    const transientFailure = new Error('database temporarily unavailable');
    mocks.findDeployment.mockRejectedValueOnce(transientFailure);

    await expect(
      startAppBackend(KEEP_ALIVE_APP_ID, {
        keepAlive: true,
        expectedDeploymentId: KEEP_ALIVE_DEPLOYMENT_ID,
      }),
    ).rejects.toBe(transientFailure);
    expect(getBackendRuntimeView(KEEP_ALIVE_APP_ID).keepAlive).toBe(true);

    mocks.findDeployment.mockResolvedValueOnce(undefined);
    await expect(
      ensureAppRunning(KEEP_ALIVE_APP_ID, KEEP_ALIVE_DEPLOYMENT_ID),
    ).rejects.toMatchObject({
      message: 'The active App deployment record is unavailable.',
      status: 503,
    });
    expect(getBackendRuntimeView(KEEP_ALIVE_APP_ID).keepAlive).toBe(false);
  });

  it('rejects a newer deployment before backend startup begins', async () => {
    const appId = 'newer-backend';
    const deploymentId = 'newer-deployment';
    mocks.findApp.mockResolvedValueOnce({
      status: 'deployed',
      capabilities: { backend: true },
      currentDeploymentId: deploymentId,
    });
    mocks.findDeployment.mockResolvedValueOnce({
      compatibilityVersion: LATEST_APP_COMPATIBILITY_VERSION + 1,
    });

    await expect(ensureAppRunning(appId, deploymentId)).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(
        new RegExp(
          `newer than this platform's latest supported v${LATEST_APP_COMPATIBILITY_VERSION}.*Update the platform`,
        ),
      ),
    });
    expect(mocks.findApp).toHaveBeenCalledOnce();
    expect(mocks.findDeployment).toHaveBeenCalledOnce();
    expect(mocks.resolveAppDatabaseUrl).not.toHaveBeenCalled();
    expect(getBackendRuntimeView(appId)).toMatchObject({
      state: 'stopped',
      pid: null,
      port: null,
      keepAlive: false,
    });
  });
});

describe('app backend runtime artifacts', () => {
  it.each(['deno-run', 'deno-serve'] as const)(
    'starts a real %s artifact with its listener and port contract',
    async (runtime) => {
      const dir = runtimeDir();
      const entryPath = writeBackendEntry(dir, 'backend/main.bundle.js');
      writeFileSync(
        entryPath,
        runtime === 'deno-serve'
          ? 'export default { fetch: () => new Response(Deno.env.get("PORT") ?? "no-port") };'
          : 'Deno.serve({ hostname: "127.0.0.1", port: Number(Deno.env.get("PORT")) }, () => new Response(Deno.env.get("PORT")));',
      );
      writeManifest(dir, {
        backend: {
          entry: 'backend/main.bundle.js',
          format: 'bundle-v1',
          runtime,
          network: [],
        },
      });
      const server = net.createServer();
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = (server.address() as net.AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const artifact = resolveBackendArtifact(dir);
      const args = buildBackendDenoArgs({
        artifact,
        buildDir: dir,
        port,
        storageDir: null,
        cacheDir: null,
        certPaths: [],
        automaticNetworkDestinations: [`127.0.0.1:${port}`],
        hasLock: false,
      });
      const env = { ...process.env };
      delete env.PORT;
      Object.assign(env, backendPortEnv(artifact.runtime, port));
      const proc = spawn('deno', args, { cwd: dir, env });
      const closed = once(proc, 'close');
      let output = '';
      proc.stdout.on('data', (chunk) => (output += chunk.toString()));
      proc.stderr.on('data', (chunk) => (output += chunk.toString()));
      try {
        let response: Response | undefined;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && proc.exitCode === null) {
          try {
            response = await fetch(`http://127.0.0.1:${port}/`, {
              signal: AbortSignal.timeout(200),
            });
            break;
          } catch {
            await delay(20);
          }
        }
        if (!response) throw new Error(`Backend did not start: ${output}`);
        expect(await response.text()).toBe(
          runtime === 'deno-serve' ? 'no-port' : String(port),
        );
      } finally {
        proc.kill();
        await closed;
      }
    },
  );

  it('uses the runtime recorded in each artifact when switching deployments', () => {
    const dir = runtimeDir();
    const entry = writeBackendEntry(dir, 'backend/main.bundle.js');
    for (const runtime of ['deno-serve', 'deno-run'] as const) {
      writeManifest(dir, {
        backend: {
          entry: 'backend/main.bundle.js',
          format: 'bundle-v1',
          runtime,
        },
      });
      const artifact = resolveBackendArtifact(dir);
      expect(artifact).toEqual({
        entryPath: entry,
        format: 'bundle-v1',
        runtime,
      });
      const args = buildBackendDenoArgs({
        artifact,
        buildDir: dir,
        port: 45678,
        storageDir: null,
        cacheDir: null,
        certPaths: [],
        hasLock: false,
      });
      expect(args[0]).toBe(runtime === 'deno-serve' ? 'serve' : 'run');
    }
  });

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

  it('reads and validates the deployment network policy', () => {
    const blockedDir = runtimeDir();
    const restrictedDir = runtimeDir();
    const blockedEntry = writeBackendEntry(
      blockedDir,
      'backend/main.bundle.js',
    );
    const restrictedEntry = writeBackendEntry(
      restrictedDir,
      'backend/main.bundle.js',
    );
    writeManifest(blockedDir, {
      backend: {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
        network: [],
      },
    });
    writeManifest(restrictedDir, {
      backend: {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
        network: ['API.EXAMPLE.COM:0443'],
      },
    });

    expect(resolveBackendArtifact(blockedDir)).toEqual({
      entryPath: blockedEntry,
      format: 'bundle-v1',
      network: [],
    });
    expect(resolveBackendArtifact(restrictedDir)).toEqual({
      entryPath: restrictedEntry,
      format: 'bundle-v1',
      network: ['api.example.com:443'],
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
      'unknown runtime',
      JSON.stringify({
        backend: { entry: 'backend/main.js', runtime: 'node' },
      }),
      /unsupported backend runtime.*node/,
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
    [
      'invalid network policy',
      JSON.stringify({
        backend: { entry: 'backend/main.ts', network: ['https://example.com'] },
      }),
      /backend\.network is invalid/,
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

  it('runs source artifacts with the historical port contract', () => {
    expect(
      buildBackendDenoArgs({
        artifact: { entryPath: '/build/backend/main.ts' },
        buildDir: '/build',
        port: 45678,
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
    expect(backendPortEnv(undefined, 45678)).toEqual({ PORT: '45678' });
  });

  it('runs bundles that explicitly select deno-run', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
        runtime: 'deno-run',
      },
      buildDir: '/build',
      port: 45678,
      storageDir: null,
      cacheDir: '/deno-cache',
      certPaths: [],
      hasLock: true,
    });

    expect(args[0]).toBe('run');
    expect(args).not.toContain('--host=127.0.0.1');
    expect(args).not.toContain('--port=45678');
    expect(args).toContain('--no-config');
    expect(backendPortEnv('deno-run', 45678)).toEqual({ PORT: '45678' });
  });

  it('withholds storage environment and filesystem permissions when disabled', () => {
    const legacyArgs = buildBackendDenoArgs({
      artifact: { entryPath: '/build/backend/main.ts' },
      buildDir: '/build',
      port: 45678,
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
      port: 45678,
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

  it('serves bundles that select deno-serve without PORT injection', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
        runtime: 'deno-serve',
      },
      buildDir: '/build',
      port: 45678,
      storageDir: '/storage',
      cacheDir: '/deno-cache',
      certPaths: ['/tls/ca.pem'],
      hasLock: true,
    });

    expect(args).toEqual([
      'serve',
      '--host=127.0.0.1',
      '--port=45678',
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
    expect(backendPortEnv('deno-serve', 45678)).toEqual({});
  });

  it('scopes network access to automatic platform targets and declarations', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
        network: ['api.example.com:443'],
      },
      buildDir: '/build',
      port: 45678,
      storageDir: null,
      cacheDir: '/deno-cache',
      certPaths: [],
      automaticNetworkDestinations: [
        '127.0.0.1:4100',
        'localhost:3700',
        'localhost:3700',
      ],
      hasLock: true,
    });

    expect(args).toContain(
      '--allow-net=127.0.0.1:4100,localhost:3700,api.example.com:443',
    );
    expect(args).not.toContain('--allow-net');
  });

  it('omits network permission for an empty policy without platform targets', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
        network: [],
      },
      buildDir: '/build',
      port: 45678,
      storageDir: null,
      cacheDir: null,
      certPaths: [],
      hasLock: false,
    });

    expect(args.some((arg) => arg.startsWith('--allow-net'))).toBe(false);
  });

  it('keeps explicit unrestricted access equivalent to the legacy default', () => {
    const args = buildBackendDenoArgs({
      artifact: {
        entryPath: '/build/backend/main.bundle.js',
        format: 'bundle-v1',
        network: 'unrestricted',
      },
      buildDir: '/build',
      port: 45678,
      storageDir: null,
      cacheDir: null,
      certPaths: [],
      automaticNetworkDestinations: ['127.0.0.1:4100'],
      hasLock: false,
    });

    expect(args).toContain('--allow-net');
    expect(args.some((arg) => arg.startsWith('--allow-net='))).toBe(false);
  });
});

describe('App extra permission runtime boundary', () => {
  it('reads artifact declarations and merges platform permissions', () => {
    const dir = runtimeDir();
    writeBackendEntry(dir, 'backend/main.bundle.js');
    writeManifest(dir, {
      backend: {
        entry: 'backend/main.bundle.js',
        format: 'bundle-v1',
        network: ['one:443'],
        extraPermissions: ['--allow-read', '--allow-net', '--allow-run=echo'],
      },
    });
    const artifact = resolveBackendArtifact(dir);
    expect(artifact.extraPermissions).toEqual([
      '--allow-read',
      '--allow-net',
      '--allow-run=echo',
    ]);
    const options = {
      artifact,
      buildDir: dir,
      port: 34567,
      storageDir: '/storage',
      cacheDir: null,
      certPaths: [],
      hasLock: false,
    };
    const args = buildBackendDenoArgs(options);
    expect(args).toContain('--allow-read');
    expect(args).toContain('--allow-net');
    expect(args).toContain('--allow-run=echo');
    expect(args.some((arg) => arg.startsWith('--allow-read='))).toBe(false);
    expect(args).not.toContain('--allow-net=one:443');
    expect(
      buildBackendDenoArgs({
        ...options,
        artifact: { ...artifact, extraPermissions: ['--allow-all'] },
      }).filter((arg) => arg.startsWith('--allow-')),
    ).toEqual(['--allow-all']);
  });
  it.each([
    null,
    '--allow-run',
    ['--inspect'],
    ['--allow-run=echo\n--inspect'],
    ['--allow-read=/x\0'],
    [42],
  ])('fails closed on persisted permissions %j', (extraPermissions) => {
    const dir = runtimeDir();
    writeBackendEntry(dir, 'backend/main.ts');
    writeManifest(dir, {
      backend: { entry: 'backend/main.ts', extraPermissions },
    });
    expect(() => resolveBackendArtifact(dir)).toThrow(
      /Invalid backend artifact: backend.extraPermissions is invalid/,
    );
  });
});
