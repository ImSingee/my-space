import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'SECRET',
  'BETTER_AUTH_SECRET',
  'AGENT_RUNNER_TOKEN',
  'AGENT_INTERNAL_HOST',
  'AGENT_INTERNAL_PORT',
  'NODE_ENV',
  'HATCH_PLATFORM_URL',
  'HATCH_RUNNER_ID',
  'HATCH_ALLOW_UNSANDBOXED',
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getPlatformEnv', () => {
  it.each([undefined, '', '   '])(
    'requires SECRET when it is %s',
    async (secret) => {
      vi.stubEnv('SECRET', secret);
      vi.stubEnv('BETTER_AUTH_SECRET', 'auth-only-secret');
      const { getPlatformEnv } = await import('./env');

      expect(() => getPlatformEnv()).toThrow('SECRET is not set');
    },
  );

  it('does not cache a failed resolution', async () => {
    const { getPlatformEnv } = await import('./env');

    expect(() => getPlatformEnv()).toThrow('SECRET is not set');

    vi.stubEnv('SECRET', 'platform-secret');
    expect(getPlatformEnv().secret).toBe('platform-secret');
  });

  it.each([undefined, '', '   '])(
    'uses SECRET when BETTER_AUTH_SECRET is %s',
    async (authSecret) => {
      vi.stubEnv('SECRET', 'platform-secret');
      vi.stubEnv('BETTER_AUTH_SECRET', authSecret);
      const { getPlatformEnv } = await import('./env');

      expect(getPlatformEnv()).toMatchObject({
        secret: 'platform-secret',
        betterAuthSecret: 'platform-secret',
      });
    },
  );

  it('preserves an explicitly configured Better Auth secret', async () => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('BETTER_AUTH_SECRET', 'auth-secret');
    const { getPlatformEnv } = await import('./env');

    expect(getPlatformEnv()).toMatchObject({
      secret: 'platform-secret',
      betterAuthSecret: 'auth-secret',
    });
  });

  it('uses the development runner defaults', async () => {
    vi.stubEnv('SECRET', 'platform-secret');
    const { getPlatformEnv } = await import('./env');

    expect(getPlatformEnv()).toMatchObject({
      agentRunnerToken: 'hatch-dev-runner-token',
      agentInternalHost: '127.0.0.1',
      agentInternalPort: 3701,
    });
  });

  it('reads the configured runner token, host, and port', async () => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('AGENT_RUNNER_TOKEN', '  runner-token  ');
    vi.stubEnv('AGENT_INTERNAL_HOST', '0.0.0.0');
    vi.stubEnv('AGENT_INTERNAL_PORT', '4701');
    const { getPlatformEnv } = await import('./env');

    expect(getPlatformEnv()).toMatchObject({
      agentRunnerToken: 'runner-token',
      agentInternalHost: '0.0.0.0',
      agentInternalPort: 4701,
    });
  });

  it.each([undefined, '', '   ', 'hatch-dev-runner-token'])(
    'disables the runner endpoint in production for token %s',
    async (token) => {
      vi.stubEnv('SECRET', 'platform-secret');
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_RUNNER_TOKEN', token);
      const { getPlatformEnv } = await import('./env');

      expect(getPlatformEnv().agentRunnerToken).toBeNull();
    },
  );

  it('returns one frozen snapshot and ignores later environment changes', async () => {
    vi.stubEnv('SECRET', 'first-secret');
    vi.stubEnv('AGENT_INTERNAL_PORT', '4701');
    const { getPlatformEnv } = await import('./env');

    const first = getPlatformEnv();
    vi.stubEnv('SECRET', 'second-secret');
    vi.stubEnv('AGENT_INTERNAL_PORT', '5701');
    const second = getPlatformEnv();

    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(second.secret).toBe('first-secret');
    expect(second.agentInternalPort).toBe(4701);
  });
});

describe('getAgentRunnerEnv', () => {
  it('uses development defaults', async () => {
    const { getAgentRunnerEnv } = await import('./env');

    expect(getAgentRunnerEnv()).toEqual({
      platformUrl: 'http://127.0.0.1:3701',
      wsUrl: 'ws://127.0.0.1:3701/internal/agent/runner/ws',
      token: 'hatch-dev-runner-token',
      runnerId: `runner-${os.hostname()}`,
      production: false,
      allowUnsandboxed: false,
    });
  });

  it('reads production runner configuration', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HATCH_PLATFORM_URL', 'https://platform.example.test:4701///');
    vi.stubEnv('AGENT_RUNNER_TOKEN', '  runner-token  ');
    vi.stubEnv('HATCH_RUNNER_ID', '  runner-one  ');
    vi.stubEnv('HATCH_ALLOW_UNSANDBOXED', 'true');
    const { getAgentRunnerEnv } = await import('./env');

    expect(getAgentRunnerEnv()).toEqual({
      platformUrl: 'https://platform.example.test:4701',
      wsUrl: 'wss://platform.example.test:4701/internal/agent/runner/ws',
      token: 'runner-token',
      runnerId: 'runner-one',
      production: true,
      allowUnsandboxed: true,
    });
  });

  it.each([undefined, '', '   '])(
    'requires AGENT_RUNNER_TOKEN in production when it is %s',
    async (token) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_RUNNER_TOKEN', token);
      const { getAgentRunnerEnv } = await import('./env');

      expect(() => getAgentRunnerEnv()).toThrow(
        'AGENT_RUNNER_TOKEN is required in production.',
      );
    },
  );

  it('returns one frozen snapshot and ignores later environment changes', async () => {
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'first-token');
    vi.stubEnv('HATCH_RUNNER_ID', 'runner-one');
    const { getAgentRunnerEnv } = await import('./env');

    const first = getAgentRunnerEnv();
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'second-token');
    vi.stubEnv('HATCH_RUNNER_ID', 'runner-two');
    const second = getAgentRunnerEnv();

    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(second.token).toBe('first-token');
    expect(second.runnerId).toBe('runner-one');
  });
});

it('caches platform and Agent Runner environments independently', async () => {
  vi.stubEnv('SECRET', 'platform-secret');
  vi.stubEnv('AGENT_RUNNER_TOKEN', 'platform-token');
  const { getAgentRunnerEnv, getPlatformEnv } = await import('./env');

  const platform = getPlatformEnv();
  vi.stubEnv('AGENT_RUNNER_TOKEN', 'runner-token');
  const runner = getAgentRunnerEnv();

  expect(platform.agentRunnerToken).toBe('platform-token');
  expect(runner.token).toBe('runner-token');
  expect(getPlatformEnv()).toBe(platform);
  expect(getAgentRunnerEnv()).toBe(runner);
});
