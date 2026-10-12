import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TailscaleManager } from './tailscale-manager';
import type { TailscaleConfig } from '../tailscale';

// Managers under test get injected load/save; the default persistence is unused.
vi.mock('./platform-config', () => {
  type PlatformConfig = typeof import('./platform-config');
  return {
    getPlatformConfig: vi.fn<PlatformConfig['getPlatformConfig']>(),
    setPlatformConfig: vi.fn<PlatformConfig['setPlatformConfig']>(),
  };
});

const managers: TailscaleManager[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(
  origin = 'https://hatch.example.ts.net',
  report?: Record<string, unknown>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hatch-tailscale-test-'));
  directories.push(dir);
  const binary = path.join(dir, 'helper');
  const pidFile = path.join(dir, 'helper.pid');
  const statusFile = path.join(dir, 'status.json');
  const inputFile = path.join(dir, 'input.json');
  const argsFile = path.join(dir, 'args.json');
  await writeFile(
    statusFile,
    JSON.stringify(
      report ?? { state: 'connected', origin, loginUrl: '', message: '' },
    ),
  );
  await writeFile(
    binary,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
if (process.env.SECRET || process.env.TS_AUTHKEY || process.env.DATABASE_URL) process.exit(2);
process.stdin.resume();
process.stdin.on('data', (chunk) => require('node:fs').writeFileSync(${JSON.stringify(inputFile)}, chunk));
process.stdin.on('end', () => process.exit());
let previous;
setInterval(() => {
  const next = require('node:fs').readFileSync(${JSON.stringify(statusFile)}, 'utf8');
  if (next !== previous) { console.log(next); previous = next; }
}, 25);
`,
    { mode: 0o700 },
  );
  let config: TailscaleConfig = { enabled: false, hostname: 'hatch' };
  const create = () => {
    const manager = new TailscaleManager({
      binary,
      stateDir: path.join(dir, 'state'),
      port: 3700,
      load: async () => ({ ...config }),
      save: async (value) => {
        config = { ...value };
      },
    });
    managers.push(manager);
    return manager;
  };
  return {
    create,
    getConfig: () => config,
    binary,
    pidFile,
    statusFile,
    inputFile,
    argsFile,
  };
}

it('enrolls with an explicit key over stdin without persisting or returning it, and restores without that key', async () => {
  vi.stubEnv('TS_AUTHKEY', 'ambient-must-not-reach-helper');
  const { create, getConfig, inputFile, argsFile } = await fixture();
  const manager = create();
  const authKey = 'tskey-auth-fixture-secret';
  const initial = await manager.configure({
    enabled: true,
    hostname: 'hatch',
    authKey,
  });
  await vi.waitFor(async () => {
    expect(JSON.parse(await readFile(inputFile, 'utf8'))).toEqual({ authKey });
  });
  const args = JSON.parse(await readFile(argsFile, 'utf8'));
  expect(args).toContain('--auth-key-stdin');
  expect(JSON.stringify(args)).not.toContain(authKey);
  expect(getConfig()).toEqual({ enabled: true, hostname: 'hatch' });
  expect(JSON.stringify(initial)).not.toContain(authKey);
  await vi.waitFor(() => expect(manager.snapshot().state).toBe('connected'));
  expect(JSON.stringify(manager.snapshot())).not.toContain(authKey);
  await manager.shutdown();
  const restored = create();
  await restored.initialize();
  await vi.waitFor(() => expect(restored.snapshot().state).toBe('connected'));
  expect(JSON.parse(await readFile(argsFile, 'utf8'))).not.toContain(
    '--auth-key-stdin',
  );
});

it('keeps enrollment failures after helper exit and can retry interactively', async () => {
  const message = 'Auth key sign-in failed. Check the key and reconnect.';
  const { create, binary, statusFile } = await fixture(undefined, {
    state: 'error',
    origin: '',
    loginUrl: '',
    message,
  });
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.stdin.once('data', () => {
  console.log(require('node:fs').readFileSync(${JSON.stringify(statusFile)}, 'utf8'));
  process.exit();
});
`,
    { mode: 0o700 },
  );
  const manager = create();
  await manager.configure({
    enabled: true,
    hostname: 'hatch',
    authKey: 'fixture',
  });
  await vi.waitFor(() => expect(manager.snapshot().message).toBe(message));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(manager.snapshot()).toMatchObject({
    state: 'error',
    origin: null,
    loginUrl: null,
    message,
  });
  await manager.configure({ enabled: true, hostname: 'hatch' });
  expect(manager.snapshot()).toMatchObject({
    state: 'starting',
    message: null,
  });
});

it('never exposes an interactive authorization URL during key-based enrollment', async () => {
  const { create } = await fixture(undefined, {
    state: 'needs-login',
    origin: '',
    loginUrl: 'https://login.tailscale.com/a/fixture',
    message: '',
  });
  const manager = create();
  await manager.configure({
    enabled: true,
    hostname: 'hatch',
    authKey: 'fixture',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(manager.snapshot()).toMatchObject({
    state: 'starting',
    loginUrl: null,
    origin: null,
  });
});

it('rejects invalid enrollment requests before saving or starting a helper', async () => {
  const { create, getConfig } = await fixture();
  const manager = create();
  await expect(
    manager.configure({ enabled: true, hostname: 'hatch', authKey: '   ' }),
  ).rejects.toThrow('Enter an auth key');
  await expect(
    manager.configure({
      enabled: false,
      hostname: 'hatch',
      authKey: 'fixture',
    }),
  ).rejects.toThrow('Auth keys can only be used when connecting');
  expect(getConfig()).toEqual({ enabled: false, hostname: 'hatch' });
  expect(manager.snapshot().state).toBe('disconnected');
});

it('handles a failed helper spawn with credentials without unhandled stdin errors', async () => {
  const { create, binary } = await fixture();
  await writeFile(binary, '#!/nonexistent-hatch-interpreter\n', {
    mode: 0o700,
  });
  const manager = create();
  await manager.configure({
    enabled: true,
    hostname: 'hatch',
    authKey: 'fixture-secret',
  });
  await vi.waitFor(() => expect(manager.snapshot().state).toBe('error'));
  expect(manager.snapshot()).toMatchObject({ loginUrl: null, origin: null });
  expect(JSON.stringify(manager.snapshot())).not.toContain('fixture-secret');
  await manager.configure({ enabled: false, hostname: 'hatch' });
  expect(manager.snapshot().state).toBe('disconnected');
});

it('forwards independent DNS diagnostics and clears them when lifecycle or helper data changes', async () => {
  const report = {
    state: 'error',
    origin: '',
    loginUrl: '',
    message: 'Enable HTTPS certificates. Retrying automatically.',
    dns: { magicDnsEnabled: true, httpsCertificatesEnabled: false },
  };
  const { create, statusFile } = await fixture(undefined, report);
  const manager = create();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() => expect(manager.snapshot().dns).toEqual(report.dns));
  expect(manager.trustedOrigin()).toBeNull();

  await writeFile(
    statusFile,
    JSON.stringify({
      ...report,
      dns: { magicDnsEnabled: null, httpsCertificatesEnabled: null },
    }),
  );
  await vi.waitFor(() =>
    expect(manager.snapshot().dns).toEqual({
      magicDnsEnabled: null,
      httpsCertificatesEnabled: null,
    }),
  );

  await writeFile(statusFile, JSON.stringify({ ...report, dns: undefined }));
  await vi.waitFor(() => expect(manager.snapshot().dns).toBeNull());
  await writeFile(statusFile, JSON.stringify(report));
  await vi.waitFor(() => expect(manager.snapshot().dns).toEqual(report.dns));

  const restarted = await manager.configure({
    enabled: true,
    hostname: 'hatch',
  });
  expect(restarted).toMatchObject({
    state: 'starting',
    dns: null,
    message: null,
  });
  await vi.waitFor(() => expect(manager.snapshot().dns).toEqual(report.dns));
  const stopped = await manager.configure({
    enabled: false,
    hostname: 'hatch',
  });
  expect(stopped).toMatchObject({
    state: 'disconnected',
    dns: null,
    message: null,
  });
});

it('restores an enabled connection after restart without passing platform or ambient Tailscale credentials', async () => {
  vi.stubEnv('SECRET', 'must-not-reach-helper');
  vi.stubEnv('DATABASE_URL', 'must-not-reach-helper');
  vi.stubEnv('TS_AUTHKEY', 'must-not-reach-helper');
  const { create } = await fixture();
  const first = create();
  await first.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() =>
    expect(first.trustedOrigin()).toBe('https://hatch.example.ts.net'),
  );
  await first.shutdown();
  expect(first.trustedOrigin()).toBeNull();
  const second = create();
  await second.initialize();
  await vi.waitFor(() => expect(second.snapshot().state).toBe('connected'));
});

it('accepts HTTPS preparation without trusting its address and recovers when the helper reports readiness', async () => {
  const { create, statusFile } = await fixture(undefined, {
    state: 'preparing-https',
    origin: 'https://hatch.example.ts.net',
    loginUrl: '',
    message: '',
    dns: { magicDnsEnabled: true, httpsCertificatesEnabled: true },
    https: { phase: 'certificate', retryAt: null },
  });
  const manager = create();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() =>
    expect(manager.snapshot()).toMatchObject({
      state: 'preparing-https',
      origin: null,
      message: null,
      https: { phase: 'certificate', retryAt: null },
    }),
  );
  expect(manager.trustedOrigin()).toBeNull();
  await writeFile(
    statusFile,
    JSON.stringify({
      state: 'error',
      origin: '',
      loginUrl: '',
      message: 'Certificate requests are limited.',
      dns: { magicDnsEnabled: true, httpsCertificatesEnabled: true },
      https: { phase: 'rate-limited', retryAt: '2026-10-12T01:00:00Z' },
    }),
  );
  await vi.waitFor(() =>
    expect(manager.snapshot().https).toEqual({
      phase: 'rate-limited',
      retryAt: '2026-10-12T01:00:00Z',
    }),
  );
  expect(manager.trustedOrigin()).toBeNull();
  await writeFile(
    statusFile,
    JSON.stringify({
      state: 'connected',
      origin: 'https://hatch.example.ts.net',
      loginUrl: '',
      message: '',
      dns: { magicDnsEnabled: true, httpsCertificatesEnabled: true },
      https: { phase: 'ready', retryAt: null },
    }),
  );
  await vi.waitFor(() =>
    expect(manager.trustedOrigin()).toBe('https://hatch.example.ts.net'),
  );
  expect(manager.snapshot().https?.phase).toBe('ready');
  await manager.configure({ enabled: false, hostname: 'hatch' });
  expect(manager.snapshot()).toMatchObject({ dns: null, https: null });
});

it('serializes competing mutations and persists disconnect so restart cannot reopen access', async () => {
  const { create, getConfig } = await fixture();
  const manager = create();
  await Promise.all([
    manager.configure({ enabled: true, hostname: 'hatch' }),
    manager.configure({ enabled: false, hostname: 'hatch' }),
  ]);
  expect(manager.snapshot()).toMatchObject({
    state: 'disconnected',
    enabled: false,
    origin: null,
  });
  expect(getConfig().enabled).toBe(false);
  const restarted = create();
  await restarted.initialize();
  expect(restarted.snapshot().state).toBe('disconnected');
});

it('never trusts a malformed or unrelated origin reported by a helper', async () => {
  const { create } = await fixture('https://attacker.example');
  const manager = create();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() => expect(manager.snapshot().state).toBe('error'));
  expect(manager.trustedOrigin()).toBeNull();
});

it('revokes trust when a helper stops reporting status', async () => {
  const { create } = await fixture();
  const manager = create();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() => expect(manager.trustedOrigin()).not.toBeNull());
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  expect(manager.trustedOrigin()).toBeNull();
  expect(manager.snapshot()).toMatchObject({ enabled: true, state: 'error' });
});

it('revokes trust after a helper crashes and permits an explicit reconnect', async () => {
  const { create, pidFile } = await fixture();
  const manager = create();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() => expect(manager.trustedOrigin()).not.toBeNull());
  process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
  await vi.waitFor(() => expect(manager.snapshot().state).toBe('error'));
  expect(manager.trustedOrigin()).toBeNull();
  await manager.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() => expect(manager.trustedOrigin()).not.toBeNull());
});

it('does not persist enabling ingress when the helper is unavailable', async () => {
  const { create, binary, getConfig } = await fixture();
  await rm(binary);
  const manager = create();
  await expect(
    manager.configure({ enabled: true, hostname: 'hatch' }),
  ).rejects.toThrow('not included');
  expect(getConfig().enabled).toBe(false);
  expect((await manager.getStatus()).available).toBe(false);
});
