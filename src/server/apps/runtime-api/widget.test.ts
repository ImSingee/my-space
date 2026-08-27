import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  liveAppDeployment:
    vi.fn<(id: string, capability: string) => Promise<unknown>>(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~server/apps/access', () => ({
  liveAppDeployment: mocks.liveAppDeployment,
}));

import { handleWidgetRequest } from './widget';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
});

it('returns 503 instead of serving an unsupported widget bundle', async () => {
  mocks.liveAppDeployment.mockResolvedValue({
    state: 'unsupported',
    compatibility: {
      version: 0,
      latestVersion: 2,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const response = await handleWidgetRequest({
    request: new Request(
      'https://hatch.test/api/app/example/widget/summary.js',
    ),
  });

  expect(response.status).toBe(503);
  await expect(response.text()).resolves.toContain('cannot run');
});
