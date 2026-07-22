import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalPlatformUrl } from './internal-platform-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('internalPlatformUrl', () => {
  it('uses the platform default port', () => {
    vi.stubEnv('PORT', undefined);

    expect(internalPlatformUrl('/api/apps/demo/kv')).toBe(
      'http://localhost:3700/api/apps/demo/kv',
    );
  });

  it('uses the configured platform port', () => {
    vi.stubEnv('PORT', '4711');

    expect(internalPlatformUrl('/api/apps/demo/kv')).toBe(
      'http://localhost:4711/api/apps/demo/kv',
    );
  });

  it('does not depend on the Better Auth public origin', () => {
    vi.stubEnv('PORT', undefined);
    vi.stubEnv('BETTER_AUTH_URL', 'https://public.example.test');

    expect(internalPlatformUrl('/api/workflow-hooks/demo/run')).toBe(
      'http://localhost:3700/api/workflow-hooks/demo/run',
    );
  });
});
