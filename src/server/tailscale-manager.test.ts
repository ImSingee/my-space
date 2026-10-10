import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { TailscaleManager } from './tailscale-manager';
import type { TailscaleConfig } from '../tailscale';
import type { AppServiceAdvertisement } from '../app-tailscale';

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
  loadServices?: () => Promise<AppServiceAdvertisement[]>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hatch-tailscale-test-'));
  directories.push(dir);
  const binary = path.join(dir, 'helper');
  const pidFile = path.join(dir, 'helper.pid');
  await writeFile(
    binary,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (process.env.SECRET || process.env.TS_AUTHKEY || process.env.DATABASE_URL) process.exit(2);
process.stdin.resume();
process.stdin.on('end', () => process.exit());
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const control = JSON.parse(line);
  require('node:fs').writeFileSync(${JSON.stringify(pidFile + '.control')}, line, {mode: 0o600});
  console.log(JSON.stringify({state: 'connected', origin: ${JSON.stringify(origin)}, loginUrl: '', message: '', suffix: 'example.ts.net', services: control.services.map(service => ({...service, state: 'ready', origin: 'https://' + service.serviceName + '.example.ts.net', message: ''}))}));
});
console.log(JSON.stringify({ state: 'connected', origin: ${JSON.stringify(origin)}, loginUrl: '', message: '' }));
`,
    { mode: 0o700 },
  );
  let config: TailscaleConfig = { enabled: false, hostname: 'hatch' };
  const create = () => {
    const manager = new TailscaleManager({
      binary,
      stateDir: path.join(dir, 'state'),
      port: 3700,
      loadServices,
      load: async () => ({ ...config }),
      save: async (value) => {
        config = { ...value };
      },
    });
    managers.push(manager);
    return manager;
  };
  return { create, getConfig: () => config, binary, pidFile };
}

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

it('recovers persisted App advertisements with fresh private proof and withdraws removed or revised bindings', async () => {
  let services: AppServiceAdvertisement[] = [
    { appId: 'app-a', serviceName: 'notes', revision: 'one', enabled: true },
  ];
  const { create, pidFile } = await fixture(undefined, async () => services);
  const first = create();
  await first.configure({ enabled: true, hostname: 'hatch' });
  await vi.waitFor(() =>
    expect(first.serviceSnapshot('app-a')?.state).toBe('ready'),
  );
  const oldProof = (
    JSON.parse(await readFile(pidFile + '.control', 'utf8')) as {
      token: string;
    }
  ).token;
  expect(first.verifyIngress(oldProof)).toBe(true);
  expect(first.verifyIngress('ü'.repeat(43))).toBe(false);
  await expect(
    first.configure({ enabled: true, hostname: 'notes' }),
  ).rejects.toThrow(/already used/);
  services = [{ ...services[0]!, revision: 'two' }];
  await first.refreshServices();
  expect(first.serviceSnapshot('app-a')).toBeNull();
  await vi.waitFor(() =>
    expect(first.serviceSnapshot('app-a')?.revision).toBe('two'),
  );
  await first.shutdown();
  expect(first.verifyIngress(oldProof)).toBe(false);
  const second = create();
  await second.initialize();
  await vi.waitFor(() =>
    expect(second.serviceSnapshot('app-a')?.revision).toBe('two'),
  );
  expect(second.verifyIngress(oldProof)).toBe(false);
  services = [];
  await second.refreshServices();
  expect(second.serviceSnapshot('app-a')).toBeNull();
  await vi.waitFor(async () =>
    expect(
      (
        JSON.parse(await readFile(pidFile + '.control', 'utf8')) as {
          services: unknown[];
        }
      ).services,
    ).toEqual([]),
  );
});

it('serializes node renames and App Service identity writes so they cannot claim the same hostname', async () => {
  let services: AppServiceAdvertisement[] = [];
  const { create } = await fixture(undefined, async () => services);
  const manager = create();
  const save = () =>
    manager.mutateServices(async (hostname) => {
      if (hostname === 'notes') throw new Error('Node name conflict');
      services = [
        {
          appId: 'app-a',
          serviceName: 'notes',
          revision: 'one',
          enabled: true,
        },
      ];
    });
  const first = await Promise.allSettled([
    manager.configure({ enabled: true, hostname: 'notes' }),
    save(),
  ]);
  expect(first.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  expect(services).toEqual([]);
  await manager.configure({ enabled: true, hostname: 'hatch' });
  const second = await Promise.allSettled([
    save(),
    manager.configure({ enabled: true, hostname: 'notes' }),
  ]);
  expect(second.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  expect(manager.snapshot().hostname).toBe('hatch');
});
