import { describe, expect, it } from 'vitest';
import { resolvePlatformPort, resolveTailscalePort } from './platform-port';

describe('Platform listener and Tailscale target configuration', () => {
  it.each([
    [{}, 3000],
    [{ PORT: '3700' }, 3700],
    [{ PORT: '4100', NITRO_PORT: '4200' }, 4200],
  ])(
    'keeps the production listener and proxy target aligned for %j',
    (env, port) => {
      expect(resolvePlatformPort(env)).toBe(port);
      expect(resolveTailscalePort(env)).toBe(port);
    },
  );

  it('retains the development default and accepts an explicit port', () => {
    expect(resolvePlatformPort({}, 3700)).toBe(3700);
    expect(resolvePlatformPort({ PORT: '4100' }, 3700)).toBe(4100);
  });

  it('limits the explicit Tailscale override to the proxy target', () => {
    const env = { NITRO_PORT: '4200', HATCH_TAILSCALE_PORT: '4300' };
    expect(resolvePlatformPort(env)).toBe(4200);
    expect(resolveTailscalePort(env)).toBe(4300);
  });

  it.each(['', '0', '65536', '3000junk', '3e3', '3000.5'])(
    'rejects an ambiguous or unsupported listener port %j',
    (port) => {
      expect(() => resolvePlatformPort({ PORT: port })).toThrow('integer');
      expect(() => resolveTailscalePort({ PORT: port })).toThrow('integer');
      expect(() =>
        resolveTailscalePort({ HATCH_TAILSCALE_PORT: port }),
      ).toThrow('integer');
    },
  );
});
