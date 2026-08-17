import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'APP_URL',
  'SECRET',
  'BETTER_AUTH_SECRET',
  'AGENT_RUNNER_TOKEN',
  'AGENT_INTERNAL_HOST',
  'AGENT_INTERNAL_PORT',
  'NODE_ENV',
  'HATCH_PLATFORM_URL',
  'HATCH_RUNNER_ID',
  'HATCH_ALLOW_UNSANDBOXED',
  'TAVILY_API_KEY',
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.stubEnv('APP_URL', 'http://localhost:3700');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getPlatformEnv', () => {
  it.each([undefined, '', '   '])(
    'requires APP_URL when it is %s',
    async (appUrl) => {
      vi.stubEnv('SECRET', 'platform-secret');
      vi.stubEnv('APP_URL', appUrl);
      const { getPlatformEnv } = await import('./env');

      expect(() => getPlatformEnv()).toThrow('APP_URL is not set');
    },
  );

  it.each([
    'ftp://app.example.test',
    'https://user@app.example.test',
    'https://@app.example.test',
    'https://app.example.test:',
    'https://app.example.test\\',
    'https://app.example.test/path',
    'https://app.example.test?mode=test',
    'https://app.example.test#section',
    'not a URL',
  ])('rejects non-origin APP_URL %s', async (appUrl) => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('APP_URL', appUrl);
    const { getPlatformEnv } = await import('./env');

    expect(() => getPlatformEnv()).toThrow(
      'APP_URL must be a valid HTTP(S) origin',
    );
  });

  it.each([
    ['https://app.example.test', 'https://app.example.test'],
    ['  https://app.example.test:8443/  ', 'https://app.example.test:8443'],
    ['HTTP://APP.EXAMPLE.TEST:80/', 'http://app.example.test'],
    ['http://[::1]:3700/', 'http://[::1]:3700'],
  ])('normalizes APP_URL %s to %s', async (appUrl, expected) => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('APP_URL', appUrl);
    const { getPlatformEnv } = await import('./env');

    expect(getPlatformEnv().appUrl).toBe(expected);
  });

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
    'requires AGENT_RUNNER_TOKEN in production when it is %s',
    async (token) => {
      vi.stubEnv('SECRET', 'platform-secret');
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_RUNNER_TOKEN', token);
      const { getPlatformEnv } = await import('./env');

      expect(() => getPlatformEnv()).toThrow(
        'AGENT_RUNNER_TOKEN is required in production.',
      );
    },
  );

  it('does not cache a failed production runner token resolution', async () => {
    vi.stubEnv('SECRET', 'platform-secret');
    vi.stubEnv('NODE_ENV', 'production');
    const { getPlatformEnv } = await import('./env');

    expect(() => getPlatformEnv()).toThrow(
      'AGENT_RUNNER_TOKEN is required in production.',
    );

    vi.stubEnv('AGENT_RUNNER_TOKEN', 'runner-token');
    expect(getPlatformEnv().agentRunnerToken).toBe('runner-token');
  });

  it('returns one frozen snapshot and ignores later environment changes', async () => {
    vi.stubEnv('SECRET', 'first-secret');
    vi.stubEnv('APP_URL', 'https://first.example.test/');
    vi.stubEnv('AGENT_INTERNAL_PORT', '4701');
    const { getPlatformEnv } = await import('./env');

    const first = getPlatformEnv();
    vi.stubEnv('SECRET', 'second-secret');
    vi.stubEnv('APP_URL', 'https://second.example.test/');
    vi.stubEnv('AGENT_INTERNAL_PORT', '5701');
    const second = getPlatformEnv();

    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(second.secret).toBe('first-secret');
    expect(second.appUrl).toBe('https://first.example.test');
    expect(second.agentInternalPort).toBe(4701);
  });
});

describe('getAgentRunnerEnv', () => {
  it('uses development defaults', async () => {
    const { getAgentRunnerEnv } = await import('./env');

    expect(getAgentRunnerEnv()).toEqual({
      appUrl: 'http://localhost:3700',
      platformUrl: 'http://127.0.0.1:3701',
      wsUrl: 'ws://127.0.0.1:3701/internal/agent/runner/ws',
      token: 'hatch-dev-runner-token',
      runnerId: `runner-${os.hostname()}`,
      tavilyApiKey: null,
      production: false,
      allowUnsandboxed: false,
    });
  });

  it('reads production runner configuration', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', '  https://app.example.test:8443/  ');
    vi.stubEnv('HATCH_PLATFORM_URL', 'https://platform.example.test:4701///');
    vi.stubEnv('AGENT_RUNNER_TOKEN', '  runner-token  ');
    vi.stubEnv('HATCH_RUNNER_ID', '  runner-one  ');
    vi.stubEnv('HATCH_ALLOW_UNSANDBOXED', 'true');
    vi.stubEnv('TAVILY_API_KEY', '  tvly-test-key  ');
    const { getAgentRunnerEnv } = await import('./env');

    expect(getAgentRunnerEnv()).toEqual({
      appUrl: 'https://app.example.test:8443',
      platformUrl: 'https://platform.example.test:4701',
      wsUrl: 'wss://platform.example.test:4701/internal/agent/runner/ws',
      token: 'runner-token',
      runnerId: 'runner-one',
      tavilyApiKey: 'tvly-test-key',
      production: true,
      allowUnsandboxed: true,
    });
  });

  it.each(['', '   '])(
    'uses Tavily keyless mode for a blank API key %j',
    async (apiKey) => {
      vi.stubEnv('TAVILY_API_KEY', apiKey);
      const { getAgentRunnerEnv } = await import('./env');

      expect(getAgentRunnerEnv().tavilyApiKey).toBeNull();
    },
  );

  it.each([undefined, '', '   '])(
    'requires APP_URL when it is %s',
    async (appUrl) => {
      vi.stubEnv('APP_URL', appUrl);
      const { getAgentRunnerEnv } = await import('./env');

      expect(() => getAgentRunnerEnv()).toThrow('APP_URL is not set');
    },
  );

  it.each([
    'ftp://app.example.test',
    'https://app.example.test/path',
    'https://app.example.test?mode=test',
    'not a URL',
  ])('rejects non-origin APP_URL %s', async (appUrl) => {
    vi.stubEnv('APP_URL', appUrl);
    const { getAgentRunnerEnv } = await import('./env');

    expect(() => getAgentRunnerEnv()).toThrow(
      'APP_URL must be a valid HTTP(S) origin',
    );
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

  it.each([undefined, '', '   '])(
    'requires HATCH_RUNNER_ID in production when it is %s',
    async (runnerId) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_RUNNER_TOKEN', 'runner-token');
      vi.stubEnv('HATCH_RUNNER_ID', runnerId);
      const { getAgentRunnerEnv } = await import('./env');

      expect(() => getAgentRunnerEnv()).toThrow('HATCH_RUNNER_ID is required.');
    },
  );

  it('does not cache a failed production runner resolution', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'runner-token');
    const { getAgentRunnerEnv } = await import('./env');

    expect(() => getAgentRunnerEnv()).toThrow('HATCH_RUNNER_ID is required.');

    vi.stubEnv('HATCH_RUNNER_ID', 'runner-one');
    expect(getAgentRunnerEnv().runnerId).toBe('runner-one');
  });

  it('returns one frozen snapshot and ignores later environment changes', async () => {
    vi.stubEnv('APP_URL', 'https://first.example.test/');
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'first-token');
    vi.stubEnv('HATCH_RUNNER_ID', 'runner-one');
    vi.stubEnv('TAVILY_API_KEY', 'first-tavily-key');
    const { getAgentRunnerEnv } = await import('./env');

    const first = getAgentRunnerEnv();
    vi.stubEnv('APP_URL', 'https://second.example.test/');
    vi.stubEnv('AGENT_RUNNER_TOKEN', 'second-token');
    vi.stubEnv('HATCH_RUNNER_ID', 'runner-two');
    vi.stubEnv('TAVILY_API_KEY', 'second-tavily-key');
    const second = getAgentRunnerEnv();

    expect(Object.isFrozen(first)).toBe(true);
    expect(second).toBe(first);
    expect(second.appUrl).toBe('https://first.example.test');
    expect(second.token).toBe('first-token');
    expect(second.runnerId).toBe('runner-one');
    expect(second.tavilyApiKey).toBe('first-tavily-key');
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
