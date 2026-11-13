import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~server/apps/runtime', () => ({
  callAppBackend: vi.fn<typeof import('~server/apps/runtime').callAppBackend>(),
}));

vi.stubEnv('APP_URL', 'https://hatch.example.test');
vi.stubEnv('SECRET', 'platform-secret');

const { db, schema } = await import('~/db');
const { callAppBackend } = await import('~server/apps/runtime');
const { hatchSignature, verifyHatchSignature } =
  await import('~server/secrets');
const service = await import('./service');
const { ingestNotification } = await import('./ingest');
const { claimDueDeliveries, runClaimedDelivery, RETRY_BACKOFF_MS } =
  await import('./dispatcher');
const { deliverToWebhook } = await import('./adapters/webhook');
const { deliverToApp } = await import('./adapters/app');
const { handleNotificationRequest } =
  await import('~server/apps/runtime-api/notifications');
const { handleChannelPush } = await import('./channel-ingress');
const { syncAppNotificationDestination } = await import('./app-destinations');

const SOURCE_APP = 'source-app';
const DEST_APP = 'dest-app';
const SIGNING_SECRET = 'source-signing-secret';
const KINDS = [
  { kind: 'order.shipped', name: 'Order shipped' },
  { kind: 'order.failed', name: 'Order failed' },
];

async function seedApp(
  id: string,
  notifications: Record<string, unknown>,
  signingSecret: string,
) {
  const deploymentId = `${id}-deployment`;
  await db.insert(schema.apps).values({
    id,
    slug: id,
    name: `App ${id}`,
    status: 'deployed',
    capabilities: {
      database: false,
      frontend: false,
      widgets: false,
      backend: true,
      cron: false,
      webhook: false,
      kv: false,
      notifications: true,
    },
    signingSecret,
    currentDeploymentId: deploymentId,
  });
  await db.insert(schema.deployments).values({
    id: deploymentId,
    appId: id,
    version: 1,
    compatibilityVersion: 2,
    status: 'deployed',
    manifestNormalized: {
      id,
      name: `App ${id}`,
      backend: { entry: 'backend/main.ts' },
      notifications: {
        url: `/api/app/${id}/notifications`,
        ...notifications,
      },
    },
  });
}

const adapters = {
  webhook: deliverToWebhook,
  app: deliverToApp,
  device: vi.fn<import('./delivery').DeliveryAdapter>(async () => ({
    kind: 'success',
  })),
};

async function runAllDue() {
  const claimed = await claimDueDeliveries(20);
  for (const delivery of claimed) await runClaimedDelivery(delivery, adapters);
  return claimed.length;
}

function push(kind = 'order.shipped', extra: Record<string, unknown> = {}) {
  return {
    kind,
    title: 'Order #1 shipped',
    body: null,
    url: null,
    data: null,
    dedupeKey: null,
    occurredAt: null,
    ...extra,
  } as Parameters<typeof ingestNotification>[0]['push'];
}

const appSource = { type: 'app' as const, appId: SOURCE_APP, name: 'Source' };

type Received = { headers: http.IncomingHttpHeaders; body: string };
let webhookStatus = 200;
const received: Received[] = [];
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body });
    response.statusCode = webhookStatus;
    response.end(webhookStatus === 200 ? 'ok' : 'boom');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

beforeEach(async () => {
  await db.delete(schema.notifications);
  await db.delete(schema.notificationRoutes);
  await db.delete(schema.notificationGroups);
  await db.delete(schema.notificationDestinations);
  await db.delete(schema.notificationChannels);
  await db.delete(schema.apps);
  await seedApp(SOURCE_APP, { kinds: KINDS }, SIGNING_SECRET);
  await seedApp(DEST_APP, { kinds: [], destination: {} }, 'dest-secret');
  await db.insert(schema.notificationDestinations).values({
    id: 'dest-app-destination',
    type: 'app',
    name: 'Destination App',
    appId: DEST_APP,
  });
  received.length = 0;
  webhookStatus = 200;
  vi.mocked(callAppBackend).mockReset();
});

afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

describe('routing', () => {
  it('fans out matching routes once per destination and skips disabled ones', async () => {
    const { destination: hook } = await service.createWebhook({
      name: 'Ops hook',
      url: webhookUrl,
    });
    const { destination: muted } = await service.createWebhook({
      name: 'Muted',
      url: webhookUrl,
    });
    await service.updateDestination({ id: muted.id, enabled: false });
    const group = await service.createGroup({
      name: 'Everyone',
      destinationIds: [hook.id, muted.id, 'dest-app-destination'],
    });
    // Three overlapping routes all select `hook`; it must get one delivery.
    await service.createRoute({
      sourceType: 'any',
      targetType: 'group',
      targetId: group.id,
    });
    await service.createRoute({
      sourceType: 'app',
      sourceId: SOURCE_APP,
      kind: 'order.shipped',
      targetType: 'destination',
      targetId: hook.id,
    });
    await service.createRoute({
      sourceType: 'channel',
      targetType: 'destination',
      targetId: hook.id,
    });

    const { id } = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push(),
    });
    const detail = await service.getNotification(id);
    expect(
      detail.deliveryList.map((d) => [d.destinationName, d.routeIds.length]),
    ).toEqual(
      expect.arrayContaining([
        ['Ops hook', 2],
        ['Destination App', 1],
      ]),
    );
    expect(detail.deliveryList).toHaveLength(2);
  });

  it('never routes an App notification back to the same App', async () => {
    await seedApp('loop-app', { kinds: KINDS, destination: {} }, 'loop');
    await db.insert(schema.notificationDestinations).values({
      id: 'loop-destination',
      type: 'app',
      name: 'Loop',
      appId: 'loop-app',
    });
    await service.createRoute({
      sourceType: 'any',
      targetType: 'destination',
      targetId: 'loop-destination',
    });
    const { id } = await ingestNotification({
      source: { type: 'app', appId: 'loop-app', name: 'Loop' },
      kind: KINDS[0],
      push: push(),
    });
    expect((await service.getNotification(id)).status).toBe('unrouted');
  });

  it('stores a repeated dedupe key once per source', async () => {
    const first = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push('order.shipped', { dedupeKey: 'order-1' }),
    });
    const second = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push('order.shipped', { dedupeKey: 'order-1' }),
    });
    expect(second).toEqual({ id: first.id, deduplicated: true });
  });

  it('can still disable a route after its source stops declaring the kind', async () => {
    const { destination } = await service.createWebhook({
      name: 'Hook',
      url: webhookUrl,
    });
    const { channel } = await service.createChannel({
      name: 'Monitoring',
      kinds: [
        { kind: 'alert', name: 'Alert' },
        { kind: 'recovery', name: 'Recovery' },
      ],
    });
    const route = await service.createRoute({
      sourceType: 'channel',
      sourceId: channel.id,
      kind: 'recovery',
      targetType: 'destination',
      targetId: destination.id,
    });
    await service.updateChannel({
      id: channel.id,
      kinds: [{ kind: 'alert', name: 'Alert' }],
    });

    expect(
      await service.updateRoute({ id: route.id, enabled: false }),
    ).toMatchObject({ enabled: false, kind: 'recovery' });
    await expect(
      service.updateRoute({ id: route.id, kind: 'missing' }),
    ).rejects.toThrow('does not declare kind');
  });

  it('rejects routes for kinds the source does not declare', async () => {
    const { destination } = await service.createWebhook({
      name: 'Hook',
      url: webhookUrl,
    });
    await expect(
      service.createRoute({
        sourceType: 'app',
        sourceId: SOURCE_APP,
        kind: 'order.unknown',
        targetType: 'destination',
        targetId: destination.id,
      }),
    ).rejects.toThrow('does not declare kind');
  });
});

describe('delivery', () => {
  it('signs webhook deliveries and retries server errors with backoff', async () => {
    const { destination, secret } = await service.createWebhook({
      name: 'Hook',
      url: webhookUrl,
    });
    await service.createRoute({
      sourceType: 'any',
      targetType: 'destination',
      targetId: destination.id,
    });
    const { id } = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push(),
    });

    webhookStatus = 503;
    const before = Date.now();
    await runAllDue();
    let [delivery] = (await service.getNotification(id)).deliveryList;
    expect(delivery).toMatchObject({
      status: 'pending',
      attempts: 1,
      httpStatus: 503,
    });
    expect(Date.parse(delivery.nextAttemptAt!)).toBeGreaterThanOrEqual(
      before + RETRY_BACKOFF_MS[0],
    );

    // Make the retry due now and let it succeed.
    await db
      .update(schema.notificationDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(schema.notificationDeliveries.id, delivery.id));
    webhookStatus = 200;
    await runAllDue();
    [delivery] = (await service.getNotification(id)).deliveryList;
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 2 });

    const last = received.at(-1)!;
    expect(
      verifyHatchSignature({
        secret,
        timestamp: last.headers['x-hatch-timestamp'] as string,
        signature: last.headers['x-hatch-signature'] as string,
        payload: last.body,
      }),
    ).toBe(true);
    expect(JSON.parse(last.body)).toMatchObject({
      type: 'hatch.notification',
      attempt: 2,
      notification: {
        id,
        kind: 'order.shipped',
        source: { type: 'app', id: SOURCE_APP, slug: SOURCE_APP },
      },
    });
  });

  it('fails client errors permanently and allows a manual retry', async () => {
    const { destination } = await service.createWebhook({
      name: 'Hook',
      url: webhookUrl,
    });
    await service.createRoute({
      sourceType: 'any',
      targetType: 'destination',
      targetId: destination.id,
    });
    const { id } = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push(),
    });
    webhookStatus = 404;
    await runAllDue();
    let [delivery] = (await service.getNotification(id)).deliveryList;
    expect(delivery).toMatchObject({ status: 'failed', httpStatus: 404 });

    await service.retryDelivery(delivery.id);
    webhookStatus = 200;
    expect(await runAllDue()).toBe(1);
    [delivery] = (await service.getNotification(id)).deliveryList;
    expect(delivery.status).toBe('succeeded');
  });

  it('records the free-form result string an App destination returns', async () => {
    await service.createRoute({
      sourceType: 'app',
      targetType: 'destination',
      targetId: 'dest-app-destination',
    });
    vi.mocked(callAppBackend).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ result: `forwarded ${'x'.repeat(3000)}` }),
      contentType: 'application/json; charset=utf-8',
    });
    const { id } = await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push(),
    });
    await runAllDue();

    const [delivery] = (await service.getNotification(id)).deliveryList;
    expect(delivery.status).toBe('succeeded');
    expect(delivery.result?.startsWith('forwarded x')).toBe(true);
    expect(delivery.result).toHaveLength(2000);

    const [appId, path, init] = vi.mocked(callAppBackend).mock.calls[0];
    expect([appId, path]).toEqual([DEST_APP, '/__notification']);
    const headers = init!.headers as Record<string, string>;
    expect(
      verifyHatchSignature({
        secret: 'dest-secret',
        timestamp: headers['x-hatch-timestamp'],
        signature: headers['x-hatch-signature'],
        payload: init!.body as string,
      }),
    ).toBe(true);
  });

  it('never claims the same delivery twice while its lease is live', async () => {
    const { destination } = await service.createWebhook({
      name: 'Hook',
      url: webhookUrl,
    });
    await service.createRoute({
      sourceType: 'any',
      targetType: 'destination',
      targetId: destination.id,
    });
    await ingestNotification({
      source: appSource,
      kind: KINDS[0],
      push: push(),
    });

    const [first, second] = await Promise.all([
      claimDueDeliveries(5),
      claimDueDeliveries(5),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(await claimDueDeliveries(5)).toEqual([]);

    // A crashed worker's lease expires and the delivery becomes claimable.
    await db
      .update(schema.notificationDeliveries)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) });
    const reclaimed = await claimDueDeliveries(5);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].attempts).toBe(2);
  });
});

describe('ingress authentication', () => {
  function signedAppPush(body: string, secret = SIGNING_SECRET) {
    const timestamp = String(Date.now());
    return new Request(
      `https://hatch.example.test/api/app/${SOURCE_APP}/notifications`,
      {
        method: 'POST',
        headers: {
          'x-hatch-timestamp': timestamp,
          'x-hatch-signature': hatchSignature(secret, timestamp, body),
        },
        body,
      },
    );
  }

  it('accepts App pushes signed with that App secret for declared kinds only', async () => {
    const body = JSON.stringify({ kind: 'order.shipped', title: 'Shipped' });
    const ok = await handleNotificationRequest({
      request: signedAppPush(body),
    });
    expect(ok.status).toBe(202);

    const forged = await handleNotificationRequest({
      request: signedAppPush(body, 'dest-secret'),
    });
    expect(forged.status).toBe(403);

    const undeclared = await handleNotificationRequest({
      request: signedAppPush(
        JSON.stringify({ kind: 'order.refunded', title: 'Refund' }),
      ),
    });
    expect(undeclared.status).toBe(422);
  });

  it('requires the current channel token', async () => {
    const { channel, token } = await service.createChannel({
      name: 'Monitoring',
      kinds: [{ kind: 'alert', name: 'Alert' }],
    });
    const send = (secret: string) =>
      handleChannelPush(
        new Request(
          `https://hatch.example.test${new URL(channel.pushUrl).pathname}`,
          {
            method: 'POST',
            headers: { 'x-hatch-secret': secret },
            body: JSON.stringify({ kind: 'alert', title: 'Disk full' }),
          },
        ),
        channel.id,
      );

    expect((await send(token)).status).toBe(202);
    expect((await send(`${token}x`)).status).toBe(401);

    const rotated = await service.rotateChannelToken(channel.id);
    expect((await send(token)).status).toBe(401);
    expect((await send(rotated)).status).toBe(202);
  });
});

describe('devices', () => {
  it('binds a device to its session and removes it when the session ends', async () => {
    await db.insert(schema.user).values({
      id: 'user-1',
      name: 'Owner',
      email: 'owner@example.test',
    });
    await db.insert(schema.session).values({
      id: 'session-1',
      token: 'token-1',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 3600_000),
      updatedAt: new Date(),
    });
    const device = await service.registerDevice({
      sessionId: 'session-1',
      userId: 'user-1',
      name: 'iPhone',
      platform: 'ios',
      apnsToken: 'ab'.repeat(32),
      apnsEnvironment: 'sandbox',
      e2eKeyId: 'key-00001',
      e2eKey: Buffer.alloc(32, 7).toString('base64url'),
    });
    expect(device.device).toMatchObject({ sessionId: 'session-1' });

    await db.delete(schema.session).where(eq(schema.session.id, 'session-1'));
    expect(await service.listDestinations()).not.toContainEqual(
      expect.objectContaining({ id: device.id }),
    );
    await db.delete(schema.user);
  });
});

describe('App destinations', () => {
  it('appear when declared and survive a redeploy that drops the declaration', async () => {
    await seedApp('relay-app', { kinds: [] }, 'relay');
    const declared = {
      notifications: { url: '', kinds: [], destination: {} },
    } as never;
    const sync = (name: string, manifest: never) =>
      db.transaction((tx) =>
        syncAppNotificationDestination(tx, 'relay-app', name, manifest),
      );

    await sync('Relay', {} as never);
    const find = () =>
      db.query.notificationDestinations.findFirst({
        where: { appId: 'relay-app' },
      });
    expect(await find()).toBeUndefined();

    await sync('Relay', declared);
    const created = await find();
    expect(created).toMatchObject({ type: 'app', name: 'Relay' });
    await service.createRoute({
      sourceType: 'any',
      targetType: 'destination',
      targetId: created!.id,
    });

    await sync('Relay v2', {} as never);
    expect(await find()).toMatchObject({ id: created!.id, name: 'Relay v2' });
    expect(await service.listRoutes()).toHaveLength(1);
  });
});
