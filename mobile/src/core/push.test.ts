import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PushRegistrar,
  base64url,
  pushTap,
  verifiedTapUrl,
  type PushPlatform,
} from './push';
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
      verifyTap: async () => false,
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

describe('push taps', () => {
  const url = 'https://tracking.example.com/123';
  const tap = (fields: Record<string, unknown>) =>
    pushTap({
      hatchOrigin: origin,
      hatchNotificationId: '01JNOTIFICATION',
      ...fields,
    });
  const signed = (fields: Record<string, unknown> = {}) =>
    tap({
      hatchUrl: url,
      hatchAutoOpenUrl: true,
      hatchKid: 'key-00001',
      hatchTapMac: 'mac',
      ...fields,
    });
  // A phone that holds key-00001 for this instance and checks one signature.
  const phone = (validMac = 'mac') => ({
    records: {
      get: async (value: string) =>
        value === origin ? { kid: 'key-00001', key: 'k'.repeat(43) } : null,
      set: async () => {},
      remove: async () => {},
    },
    sharedKeys: {
      set: async () => {},
      has: async () => true,
      remove: async () => {},
      verifyTap: async (
        kid: string,
        mac: string,
        fields: { origin: string; id: string; url: string },
      ) =>
        kid === 'key-00001' &&
        mac === validMac &&
        fields.origin === origin &&
        fields.id === '01JNOTIFICATION' &&
        fields.url === url,
    },
  });

  it('opens the URL only when the sender asked and the phone signed it', async () => {
    expect(await verifiedTapUrl(signed()!, phone())).toBe(url);
    for (const target of [
      tap({ hatchUrl: url }),
      signed({ hatchAutoOpenUrl: 'true' }),
      signed({ hatchUrl: undefined }),
      signed({ hatchTapMac: undefined }),
      signed({ hatchKid: undefined }),
    ]) {
      expect(target).toMatchObject({ notificationId: '01JNOTIFICATION' });
      expect(await verifiedTapUrl(target!, phone())).toBeNull();
    }
  });

  it('opens the notification for a push the extension did not sign', async () => {
    // Forged fields from a push that skipped the extension.
    expect(await verifiedTapUrl(signed(), phone('other'))).toBeNull();
    // Signed with a key that is not this phone's key for the instance.
    expect(
      await verifiedTapUrl(signed({ hatchKid: 'key-00002' })!, phone()),
    ).toBeNull();
    const failing = phone();
    failing.sharedKeys.verifyTap = async () => {
      throw new Error('keychain unavailable');
    };
    expect(await verifiedTapUrl(signed()!, failing)).toBeNull();
  });

  it('keeps URLs the external-link policy blocks inside the app', () => {
    for (const hatchUrl of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://user:secret@tracking.example.com/',
      `${origin}/api/auth/handoffs/complete`,
      `${origin}/api/auth/%68andoffs/complete`,
      'hatch://api/auth/handoffs/consume',
      'hatch://app/%2e%2e/api',
      'not a url',
    ]) {
      expect(signed({ hatchUrl })).toMatchObject({
        notificationId: '01JNOTIFICATION',
        autoOpen: null,
      });
    }
  });

  it('lets a signed Hatch deep link open on tap', () => {
    const hatchUrl = 'hatch://app/status#/db/1';
    expect(signed({ hatchUrl })?.autoOpen).toMatchObject({
      url: hatchUrl,
      signed: { url: hatchUrl },
    });
  });

  it('opens nothing for pushes it cannot attribute', () => {
    expect(pushTap(null)).toBeNull();
    expect(pushTap({})).toBeNull();
    expect(
      pushTap({ hatchOrigin: origin, hatchNotificationId: '../settings' }),
    ).toBeNull();
    expect(signed({ hatchOrigin: 'javascript:alert(1)' })).toBeNull();
  });
});
