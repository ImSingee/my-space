import { beforeEach, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

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

it('returns a newer-platform 503 before reading frontend files', async () => {
  mocks.liveAppDeployment.mockResolvedValue({
    state: 'unsupported',
    compatibility: {
      version: LATEST_APP_COMPATIBILITY_VERSION + 1,
      latestVersion: LATEST_APP_COMPATIBILITY_VERSION,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const response = await serveAppAppFile('example', 'index.html');

  expect(response.status).toBe(503);
  await expect(response.text()).resolves.toMatch(
    /newer than this platform's latest supported.*Update the platform/,
  );
  expect(mocks.readLiveBuildFile).not.toHaveBeenCalled();
});
