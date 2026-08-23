import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp:
    vi.fn<
      (options?: unknown) => Promise<Record<string, unknown> | undefined>
    >(),
  findDeployment:
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
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: { findFirst: mocks.findDeployment },
    },
  },
}));

vi.mock('./auth', () => ({ authMiddleware: {} }));
vi.mock('./apps/access', () => ({
  normalizedManifestFor: vi.fn<() => void>(),
}));

import { getAppBySlug, getAppDeploymentRevision } from './apps';

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
    mocks.findApp.mockResolvedValueOnce(row);
    mocks.findDeployment.mockResolvedValueOnce({
      compatibilityVersion: null,
    });

    const detail = await getAppBySlug({ data: 'example' });

    expect(detail).toEqual({
      id: 'app-one',
      slug: 'example',
      name: 'Example app',
      description: null,
      status: 'deployed',
      capabilities: { frontend: true },
      deploymentRevision: 'revision-two',
      compatibility: {
        version: 1,
        latestVersion: 2,
        minimumSupportedVersion: 1,
        isSupported: true,
        isLatest: false,
      },
      currentSourceCommit: 'commit-two',
      dbName: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T01:00:00.000Z',
    });
    expect(detail).not.toHaveProperty('currentDeploymentId');
    expect(mocks.findApp).toHaveBeenCalledOnce();
    expect(mocks.findDeployment).toHaveBeenCalledOnce();
    expect(mocks.findApp.mock.calls[0]?.[0]).toMatchObject({
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
