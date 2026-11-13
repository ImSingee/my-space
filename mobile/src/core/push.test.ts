import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushRegistrar, base64url, type PushPlatform } from './push';
import type { PushRegistration } from './types';

const origin = 'https://hatch.example.test';

function setup(granted = true) {
  const shared = new Map<string, string>();
  const records = new Map<string, string>();
  const calls: string[] = [];
  const platform: PushPlatform = {
    environment: 'sandbox',
    deviceName: () => 'Test iPhone',
    permission: vi.fn<PushPlatform['permission']>(async () => granted),
    apnsToken: vi.fn<PushPlatform['apnsToken']>(
      async () => 'ABCDEF0123456789ABCDEF0123456789',
    ),
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    sharedKeys: {
      set: async (kid, key) => {
        calls.push('shared.set');
        shared.set(kid, key);
      },
      has: async (kid) => shared.has(kid),
      remove: async (kid) => {
        calls.push('shared.remove');
        shared.delete(kid);
      },
    },
    records: {
      get: async (key) => {
        const raw = records.get(key);
        return raw ? JSON.parse(raw) : null;
      },
      set: async (key, record) => {
        records.set(key, JSON.stringify(record));
      },
      remove: async (key) => {
        records.delete(key);
      },
    },
  };
  const registered: PushRegistration[] = [];
  const api = {
    registerPushDevice: vi.fn<(input: PushRegistration) => Promise<void>>(
      async (input) => {
        calls.push('server.register');
        registered.push(input);
      },
    ),
    unregisterPushDevice: vi.fn<() => Promise<void>>(async () => {
      calls.push('server.unregister');
    }),
  };
  return {
    registrar: new PushRegistrar(platform),
    platform,
    shared,
    api,
    registered,
    calls,
  };
}

describe('base64url', () => {
  it('matches Node without padding', () => {
    for (const size of [0, 1, 2, 3, 16, 31, 32]) {
      const bytes = randomBytes(size);
      expect(base64url(new Uint8Array(bytes))).toBe(
        bytes.toString('base64url'),
      );
    }
  });
});

describe('PushRegistrar', () => {
  it('registers a fresh 32-byte key shared with the extension', async () => {
    const { registrar, api, registered, shared } = setup();
    await expect(registrar.enable(origin, api)).resolves.toBe(true);
    const [input] = registered;
    expect(input).toMatchObject({
      name: 'Test iPhone',
      apnsToken: 'abcdef0123456789abcdef0123456789',
      apnsEnvironment: 'sandbox',
    });
    expect(Buffer.from(input.e2eKey, 'base64url')).toHaveLength(32);
    expect(shared.get(input.e2eKeyId)).toBe(input.e2eKey);
    await expect(registrar.enabled(origin)).resolves.toBe(true);
  });

  it('keeps the same key across refreshes and restores a missing shared copy', async () => {
    const { registrar, api, registered, shared } = setup();
    await registrar.enable(origin, api);
    shared.clear();
    await registrar.refresh(origin, api);
    expect(registered).toHaveLength(2);
    expect(registered[1].e2eKeyId).toBe(registered[0].e2eKeyId);
    expect(registered[1].e2eKey).toBe(registered[0].e2eKey);
    expect(shared.get(registered[0].e2eKeyId)).toBe(registered[0].e2eKey);
  });

  it('registers a rotated token without requesting another one', async () => {
    const { registrar, api, registered, platform } = setup();
    await registrar.enable(origin, api);
    vi.mocked(platform.apnsToken).mockClear();
    await registrar.refresh(origin, api, 'FEDCBA9876543210FEDCBA9876543210');
    expect(platform.apnsToken).not.toHaveBeenCalled();
    expect(registered[1].apnsToken).toBe('fedcba9876543210fedcba9876543210');
  });

  it('never registers when alerts are denied or push is off', async () => {
    const denied = setup(false);
    await expect(denied.registrar.enable(origin, denied.api)).resolves.toBe(
      false,
    );
    const off = setup();
    await off.registrar.refresh(origin, off.api);
    expect(denied.api.registerPushDevice).not.toHaveBeenCalled();
    expect(off.api.registerPushDevice).not.toHaveBeenCalled();
    expect(off.platform.permission).not.toHaveBeenCalled();
  });

  it('removes the decryption key before telling the instance', async () => {
    const { registrar, api, shared, calls } = setup();
    await registrar.enable(origin, api);
    api.unregisterPushDevice.mockImplementationOnce(async () => {
      calls.push('server.unregister');
      throw new Error('offline');
    });
    await expect(registrar.disable(origin, api)).rejects.toThrow('offline');
    expect(shared.size).toBe(0);
    expect(calls.slice(-2)).toEqual(['shared.remove', 'server.unregister']);
    await expect(registrar.enabled(origin)).resolves.toBe(false);
  });
});
