import { afterEach, describe, expect, it, vi } from 'vitest';
import { subprocessSandboxEnv } from './sandbox-env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('subprocessSandboxEnv', () => {
  it('uses the platform registry without inheriting auth or proxy overrides', () => {
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'http://registry.invalid/');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '/tmp/untrusted-npmrc');
    vi.stubEnv('DENO_AUTH_TOKENS', 'secret@example.invalid');
    vi.stubEnv('HTTP_PROXY', 'http://proxy.invalid/');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid/');

    expect(subprocessSandboxEnv()).toMatchObject({
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      npm_config_registry: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: undefined,
      npm_config_userconfig: undefined,
      DENO_AUTH_TOKENS: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      NO_PROXY: undefined,
    });
  });
});
