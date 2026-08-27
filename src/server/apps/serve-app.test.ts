import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  liveAppDeployment:
    vi.fn<(id: string, capability: string) => Promise<unknown>>(),
  readLiveBuildFile: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('~agent/paths', () => ({
  appBuildDir: (id: string) => `/workspace/build/${id}`,
}));
vi.mock('./access', () => ({
  liveAppDeployment: mocks.liveAppDeployment,
}));
vi.mock('./build-identity', () => ({
  readLiveBuildFile: mocks.readLiveBuildFile,
}));

import { serveAppAppFile } from './serve-app';

beforeEach(() => {
  vi.clearAllMocks();
});

it('returns 503 before reading files for an unsupported frontend', async () => {
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

  const response = await serveAppAppFile('example', 'index.html');

  expect(response.status).toBe(503);
  await expect(response.text()).resolves.toContain('cannot run');
  expect(mocks.readLiveBuildFile).not.toHaveBeenCalled();
});
