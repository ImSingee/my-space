import {
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.stubEnv('APP_URL', 'https://hatch.example.test');
vi.stubEnv('SECRET', 'platform-secret');

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
vi.stubEnv('HATCH_APNS_TEAM_ID', 'TEAM123456');
vi.stubEnv('HATCH_APNS_TOPIC', 'app.hatch.mobile');
vi.stubEnv('HATCH_APNS_SANDBOX_KEY_ID', 'KEY1234567');
vi.stubEnv('HATCH_APNS_SANDBOX_PRIVATE_KEY', pem.replaceAll('\n', '\\n'));

const { db, schema } = await import('~/db');
const service = await import('./service');
const { ingestNotification } = await import('./ingest');
const { claimDueDeliveries, runClaimedDelivery } = await import('./dispatcher');
const { createDeviceAdapter } = await import('./adapters/device');
type DeliveryAdapter = import('./delivery').DeliveryAdapter;
const { closeApnsSessions, sendApnsRequest } = await import('./apns/client');
const { APNS_MAX_PAYLOAD_BYTES, pushAssociatedData } =
  await import('./apns/payload');

const DEVICE_KEY = Buffer.alloc(32, 9);
const KEY_ID = 'device-key-1';
const TOKEN = 'cd'.repeat(32);

type Seen = { headers: http2.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let reply: { status: number; reason?: string; reset?: boolean } = {
  status: 200,
};
const apns = http2.createServer();
apns.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
  let body = '';
  stream.on('data', (chunk) => (body += chunk));
  stream.on('end', () => {
    seen.push({ headers, body });
    if (reply.reset) {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      return;
    }
    stream.respond({ ':status': reply.status });
    stream.end(reply.reason ? JSON.stringify({ reason: reply.reason }) : '');
  });
});
await new Promise<void>((resolve) => apns.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(apns.address() as AddressInfo).port}`;

const adapters = {
  device: createDeviceAdapter({
    origins: { sandbox: origin, production: origin },
  }),
  webhook: vi.fn<DeliveryAdapter>(),
  app: vi.fn<DeliveryAdapter>(),
};

function decrypt(payload: string) {
  const parsed = JSON.parse(payload) as {
    aps: { alert: { title: string; body: string } };
    h: { kid: string; c: string };
  };
  const sealed = Buffer.from(parsed.h.c, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    DEVICE_KEY,
    sealed.subarray(0, 12),
  );
  decipher.setAAD(pushAssociatedData(parsed.h.kid));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]);
  return { alert: parsed.aps.alert, content: JSON.parse(plain.toString()) };
}

async function registerDevice() {
  await db
    .insert(schema.user)
    .values({ id: 'user-1', name: 'Owner', email: 'owner@example.test' });
  await db.insert(schema.session).values({
    id: 'session-1',
    token: 'session-token',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date(),
  });
  const device = await service.registerDevice({
    sessionId: 'session-1',
    userId: 'user-1',
    name: 'iPhone',
    platform: 'ios',
    apnsToken: TOKEN,
    apnsEnvironment: 'sandbox',
    e2eKeyId: KEY_ID,
    e2eKey: DEVICE_KEY.toString('base64url'),
  });
  await service.createRoute({
    sourceType: 'any',
    targetType: 'destination',
    targetId: device.id,
  });
  return device;
}

let channelId = '';

async function deliver(title: string, body: string | null) {
  const { id } = await ingestNotification({
    source: { type: 'channel', channelId, name: 'Monitoring' },
    kind: { kind: 'alert', name: 'Alert' },
    push: {
      kind: 'alert',
      title,
      body,
      url: null,
      data: null,
      dedupeKey: null,
      occurredAt: null,
    },
  });
  for (const claimed of await claimDueDeliveries(5)) {
    await runClaimedDelivery(claimed, adapters);
  }
  return (await service.getNotification(id)).deliveryList[0];
}

beforeEach(async () => {
  await db.delete(schema.notifications);
  await db.delete(schema.notificationRoutes);
  await db.delete(schema.notificationDestinations);
  await db.delete(schema.notificationChannels);
  await db.delete(schema.user);
  channelId = (
    await service.createChannel({
      name: 'Monitoring',
      kinds: [{ kind: 'alert', name: 'Alert' }],
    })
  ).channel.id;
  seen.length = 0;
  reply = { status: 200 };
});

afterAll(() => {
  closeApnsSessions();
  apns.close();
  vi.unstubAllEnvs();
});

describe('APNs delivery', () => {
  it('sends a token-authenticated push whose content only the device can read', async () => {
    await registerDevice();
    const delivery = await deliver('Disk full', 'db-1 is at 98%');
    expect(delivery.status).toBe('succeeded');

    const [request] = seen;
    expect(request.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request.headers['apns-topic']).toBe('app.hatch.mobile');
    expect(request.headers['apns-push-type']).toBe('alert');

    const [header, claims, signature] = String(request.headers.authorization)
      .replace(/^bearer /, '')
      .split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
    });
    expect(
      JSON.parse(Buffer.from(claims, 'base64url').toString()),
    ).toMatchObject({ iss: 'TEAM123456' });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);

    expect(request.body).not.toContain('Disk full');
    const { alert, content } = decrypt(request.body);
    expect(alert).toEqual({ title: 'Hatch', body: 'New notification' });
    expect(content).toMatchObject({
      v: 1,
      o: 'https://hatch.example.test',
      t: 'Disk full',
      b: 'db-1 is at 98%',
      s: 'Monitoring',
      k: 'Alert',
    });
  });

  it('shortens long bodies to fit the APNs payload limit', async () => {
    await registerDevice();
    await deliver('Report', 'é'.repeat(4000));
    const [request] = seen;
    expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(
      APNS_MAX_PAYLOAD_BYTES,
    );
    expect(decrypt(request.body).content.b.endsWith('…')).toBe(true);
  });

  it('disables a device APNs no longer recognizes', async () => {
    const device = await registerDevice();
    reply = { status: 410, reason: 'Unregistered' };
    const delivery = await deliver('Hello', null);
    expect(delivery).toMatchObject({ status: 'failed', httpStatus: 410 });
    const [stored] = await service.listDestinations();
    expect(stored).toMatchObject({ id: device.id, enabled: false });
  });

  it('keeps the device enabled when this instance credentials are rejected', async () => {
    const device = await registerDevice();
    reply = { status: 403, reason: 'InvalidProviderToken' };
    const delivery = await deliver('Hello', null);
    expect(delivery.status).toBe('failed');
    const [stored] = await service.listDestinations();
    expect(stored).toMatchObject({ id: device.id, enabled: true });
    expect(stored.lastError).toContain('InvalidProviderToken');
  });

  it('retries throttled pushes', async () => {
    await registerDevice();
    reply = { status: 429, reason: 'TooManyRequests' };
    expect((await deliver('Hello', null)).status).toBe('pending');
  });

  it('retries a push whose stream closes before APNs responds', async () => {
    await registerDevice();
    reply = { status: 200, reset: true };
    const delivery = await deliver('Hello', null);
    expect(delivery).toMatchObject({ status: 'pending', httpStatus: null });
    expect(delivery.lastError).toContain('without a response');
  });
});

describe('device refresh', () => {
  const refresh = (apnsToken: string) =>
    service.registerDevice({
      sessionId: 'session-1',
      userId: 'user-1',
      name: 'iPhone',
      platform: 'ios',
      apnsToken,
      apnsEnvironment: 'sandbox',
      e2eKeyId: KEY_ID,
      e2eKey: DEVICE_KEY.toString('base64url'),
    });

  it('does not disable a token the phone registered while the old one failed', async () => {
    const device = await registerDevice();
    const fresh = 'ab'.repeat(32);
    const rotating = {
      ...adapters,
      device: createDeviceAdapter({
        send: async () => {
          await refresh(fresh);
          return { status: 410, reason: 'Unregistered' };
        },
      }),
    };
    await ingestNotification({
      source: { type: 'channel', channelId, name: 'Monitoring' },
      kind: { kind: 'alert', name: 'Alert' },
      push: {
        kind: 'alert',
        title: 'Hello',
        body: null,
        url: null,
        data: null,
        dedupeKey: null,
        occurredAt: null,
      },
    });
    for (const claimed of await claimDueDeliveries(5)) {
      await runClaimedDelivery(claimed, rotating);
    }
    const [stored] = await service.listDestinations();
    expect(stored).toMatchObject({ id: device.id, enabled: true });
  });

  it('keeps a renamed device name when the phone registers again', async () => {
    const device = await registerDevice();
    await service.updateDestination({ id: device.id, name: 'Work phone' });
    await refresh(TOKEN);
    const [stored] = await service.listDestinations();
    expect(stored).toMatchObject({ id: device.id, name: 'Work phone' });
  });

  it('keeps routes and groups when push is turned off and on in the app', async () => {
    const device = await registerDevice();
    const group = await service.createGroup({
      name: 'Phones',
      destinationIds: [device.id],
    });
    await service.unregisterDevice('session-1');
    expect((await service.listDestinations())[0]).toMatchObject({
      id: device.id,
      enabled: false,
    });
    await expect(
      service.updateDestination({ id: device.id, enabled: true }),
    ).rejects.toThrow('turned off on this device');

    expect(await refresh(TOKEN)).toMatchObject({
      id: device.id,
      enabled: true,
      groupIds: [group.id],
    });
    expect(await service.listRoutes()).toHaveLength(1);
  });

  it('keeps a device the user disabled disabled when the app re-registers', async () => {
    const device = await registerDevice();
    await service.updateDestination({ id: device.id, enabled: false });
    expect(await refresh(TOKEN)).toMatchObject({ enabled: false });
    expect(await refresh('ab'.repeat(32))).toMatchObject({ enabled: false });
  });

  it('revives a device APNs disabled only once it presents a new token', async () => {
    await registerDevice();
    reply = { status: 410, reason: 'Unregistered' };
    await deliver('Hello', null);
    expect(await refresh(TOKEN)).toMatchObject({ enabled: false });
    expect(await refresh('ab'.repeat(32))).toMatchObject({
      enabled: true,
      lastError: null,
    });
  });
});

describe('APNs client', () => {
  it('reports Apple rejection reasons', async () => {
    reply = { status: 400, reason: 'BadDeviceToken' };
    const result = await sendApnsRequest({
      origin,
      teamId: 'TEAM123456',
      key: { keyId: 'KEY1234567', key: privateKey },
      topic: 'app.hatch.mobile',
      deviceToken: TOKEN,
      payload: '{}',
      collapseId: 'n1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(result).toEqual({ status: 400, reason: 'BadDeviceToken' });
  });
});
