import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp:
    vi.fn<
      (options?: unknown) => Promise<Record<string, unknown> | undefined>
    >(),
}));

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    let validate = (value: unknown) => value;
    const builder = {
      middleware: () => builder,
      validator: (next: (value: never) => unknown) => {
        validate = (value) => next(value as never);
        return builder;
      },
      handler:
        (handler: (context: { data: never }) => unknown) =>
        (input: { data: unknown }) =>
          handler({ data: validate(input.data) as never }),
    };
    return builder;
  },
}));

vi.mock('~/db', () => ({
  db: { query: { apps: { findFirst: mocks.findApp } } },
}));

vi.mock('./auth', () => ({ authMiddleware: {} }));
vi.mock('./apps/access', () => ({
  normalizedManifestFor: vi.fn<() => void>(),
}));

import { getApp, getAppDeploymentRevision } from './apps';

const row = {
  id: 'app-one',
  slug: 'example',
  name: 'Example app',
  description: null,
  status: 'deployed',
  capabilities: { frontend: true },
  currentDeploymentId: 'revision-two',
  currentSourceCommit: 'commit-two',
  dbName: null,
  createdAt: new Date('2026-08-13T00:00:00.000Z'),
  updatedAt: new Date('2026-08-13T01:00:00.000Z'),
};

describe('App deployment revision views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the live deployment id to the safe detail revision field', async () => {
    mocks.findApp.mockResolvedValueOnce(undefined).mockResolvedValueOnce(row);

    const detail = await getApp({ data: 'example' });

    expect(detail).toEqual({
      id: 'app-one',
      slug: 'example',
      name: 'Example app',
      description: null,
      status: 'deployed',
      capabilities: { frontend: true },
      deploymentRevision: 'revision-two',
      currentSourceCommit: 'commit-two',
      dbName: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T01:00:00.000Z',
    });
    expect(detail).not.toHaveProperty('currentDeploymentId');
    expect(mocks.findApp).toHaveBeenCalledTimes(2);
    expect(mocks.findApp.mock.calls[1]?.[0]).toMatchObject({
      columns: {
        currentDeploymentId: true,
        currentSourceCommit: true,
      },
    });
  });

  it('reads only the canonical app id and returns its current revision', async () => {
    mocks.findApp.mockResolvedValueOnce({
      currentDeploymentId: 'revision-three',
    });

    await expect(getAppDeploymentRevision({ data: 'app-one' })).resolves.toBe(
      'revision-three',
    );

    expect(mocks.findApp).toHaveBeenCalledOnce();
    expect(mocks.findApp.mock.calls[0]?.[0]).toMatchObject({
      columns: { currentDeploymentId: true },
    });
  });

  it('returns null when no live deployment exists', async () => {
    mocks.findApp.mockResolvedValueOnce({ currentDeploymentId: null });
    await expect(
      getAppDeploymentRevision({ data: 'app-one' }),
    ).resolves.toBeNull();

    mocks.findApp.mockResolvedValueOnce(undefined);
    await expect(
      getAppDeploymentRevision({ data: 'missing-app' }),
    ).resolves.toBeNull();
  });
});
