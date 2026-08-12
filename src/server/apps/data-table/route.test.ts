import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  queryDataTable:
    vi.fn<
      (id: string, input: unknown, options?: unknown) => Promise<unknown>
    >(),
  mutateDataTable:
    vi.fn<
      (id: string, input: unknown, options?: unknown) => Promise<unknown>
    >(),
  subscribeDataChanges: vi.fn<(options: unknown) => Promise<() => void>>(),
}));

vi.mock('~/db', () => ({
  db: { query: { apps: { findFirst: mocks.findApp } } },
}));
vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~server/apps/data-table/service', () => ({
  DATA_REQUEST_MAX_BYTES: 1_000_000,
  queryDataTable: mocks.queryDataTable,
  mutateDataTable: mocks.mutateDataTable,
}));
vi.mock('~server/apps/data-table/realtime', () => ({
  subscribeDataChanges: mocks.subscribeDataChanges,
}));

import { handle } from '~/routes/api/apps/$appId/data/$.ts';

describe('managed Data Table runtime fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.subscribeDataChanges.mockResolvedValue(() => {});
  });

  it('fails closed while a schema activation is pending', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v1',
      capabilities: { dataTable: true },
      dataActivationId: 'deployment-v2',
    });

    const response = await handle({
      request: new Request(
        'https://hatch.test/api/apps/example/data/events?since=0',
      ),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.text()).resolves.toContain('being finalized');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.subscribeDataChanges).not.toHaveBeenCalled();
  });

  it('rejects a client built for an inactive deployment', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });

    const response = await handle({
      request: new Request(
        'https://hatch.test/api/apps/example/data/events?since=0',
        { headers: { 'x-hatch-data-deployment': 'deployment-v1' } },
      ),
    });

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain('inactive deployment');
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.subscribeDataChanges).not.toHaveBeenCalled();
  });

  it('passes the deployment identity into the post-lock service guard', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.queryDataTable.mockResolvedValue({
      items: [],
      cursor: null,
      revision: 0,
    });

    const response = await handle({
      request: new Request('https://hatch.test/api/apps/example/data/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hatch-data-deployment': 'deployment-v2',
        },
        body: JSON.stringify({ table: 'todos' }),
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.queryDataTable).toHaveBeenCalledWith(
      'example',
      { table: 'todos' },
      { expectedDeploymentId: 'deployment-v2' },
    );
  });

  it('binds realtime replay to the deployment that opened the stream', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });

    const response = await handle({
      request: new Request(
        'https://hatch.test/api/apps/example/data/events?since=12&table=todos',
        { headers: { 'x-hatch-data-deployment': 'deployment-v2' } },
      ),
    });

    expect(response.status).toBe(200);
    expect(mocks.subscribeDataChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'example',
        since: 12,
        table: 'todos',
        expectedDeploymentId: 'deployment-v2',
        close: expect.any(Function),
      }),
    );
    await response.body?.cancel();
  });

  it.each(['', '-1', '1.5', 'Infinity', '9007199254740992'])(
    'rejects an invalid realtime cursor before subscribing: %s',
    async (since) => {
      mocks.findApp.mockResolvedValue({
        status: 'deployed',
        currentDeploymentId: 'deployment-v2',
        capabilities: { dataTable: true },
        dataActivationId: null,
      });
      mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });

      const response = await handle({
        request: new Request(
          `https://hatch.test/api/apps/example/data/events?since=${since}`,
          { headers: { 'x-hatch-data-deployment': 'deployment-v2' } },
        ),
      });

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain('realtime cursor');
      expect(mocks.subscribeDataChanges).not.toHaveBeenCalled();
    },
  );

  it('keeps unknown infrastructure failures retryable', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.queryDataTable.mockRejectedValue(new Error('connection lost'));

    const response = await handle({
      request: new Request('https://hatch.test/api/apps/example/data/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hatch-data-deployment': 'deployment-v2',
        },
        body: JSON.stringify({ table: 'todos' }),
      }),
    });

    expect(response.status).toBe(500);
  });

  it('maps schema validation failures to a client error', async () => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    const validation = z.object({ table: z.string() }).safeParse({});
    if (validation.success) throw new Error('Expected validation to fail');
    mocks.queryDataTable.mockRejectedValue(validation.error);

    const response = await handle({
      request: new Request('https://hatch.test/api/apps/example/data/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hatch-data-deployment': 'deployment-v2',
        },
        body: '{}',
      }),
    });

    expect(response.status).toBe(400);
  });

  it.each([
    ['23505', 409],
    ['23514', 400],
  ])('maps PostgreSQL data error %s to %i', async (code, status) => {
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-v2',
      capabilities: { dataTable: true },
      dataActivationId: null,
    });
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.mutateDataTable.mockRejectedValue(
      Object.assign(new Error('constraint failed'), {
        name: 'PostgresError',
        code,
      }),
    );

    const response = await handle({
      request: new Request('https://hatch.test/api/apps/example/data/mutate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hatch-data-deployment': 'deployment-v2',
        },
        body: JSON.stringify({ operations: [] }),
      }),
    });

    expect(response.status).toBe(status);
  });
});
