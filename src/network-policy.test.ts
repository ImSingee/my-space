import { describe, expect, it } from 'vitest';
import {
  effectiveNetworkAllowlist,
  networkAccessView,
  networkDestinationFromUrl,
  networkPolicySchema,
  normalizeNetworkDestination,
} from './network-policy';

describe('network policy declarations', () => {
  it.each([
    ['api.example.com', 'api.example.com'],
    ['API.EXAMPLE.COM:0443', 'api.example.com:443'],
    ['*.Example.com', '*.example.com'],
    ['203.0.113.10:8080', '203.0.113.10:8080'],
    ['[2001:DB8::1]', '[2001:db8::1]'],
    ['[2001:db8::1]:443', '[2001:db8::1]:443'],
    ['localhost:3700', 'localhost:3700'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeNetworkDestination(input)).toBe(expected);
  });

  it.each([
    '',
    'https://example.com',
    'example.com/path',
    'example.com:0',
    'example.com:65536',
    'example.com,evil.test',
    '10.0.0.0/8',
    '*.127.0.0.1',
    '999.1.1.1',
    '2001:db8::1',
    'unix:/tmp/demo.sock',
  ])('rejects unsupported destination %s', (input) => {
    expect(networkPolicySchema.safeParse([input]).success).toBe(false);
  });

  it('deduplicates canonical destinations while preserving order', () => {
    expect(
      networkPolicySchema.parse([
        'API.EXAMPLE.COM:443',
        'api.example.com:0443',
        '203.0.113.10',
      ]),
    ).toEqual(['api.example.com:443', '203.0.113.10']);
  });
});

describe('network policy projection and enforcement inputs', () => {
  it('distinguishes legacy, blocked, restricted, and unrestricted states', () => {
    expect(networkAccessView(undefined)).toEqual({
      mode: 'unrestricted',
      destinations: [],
      legacy: true,
    });
    expect(networkAccessView([])).toEqual({
      mode: 'blocked',
      destinations: [],
      legacy: false,
    });
    expect(networkAccessView(['api.example.com:443'])).toEqual({
      mode: 'restricted',
      destinations: ['api.example.com:443'],
      legacy: false,
    });
    expect(networkAccessView('unrestricted')).toEqual({
      mode: 'unrestricted',
      destinations: [],
      legacy: false,
    });
  });

  it('merges platform destinations only for scoped policies', () => {
    expect(effectiveNetworkAllowlist(undefined, ['localhost:3700'])).toBeNull();
    expect(
      effectiveNetworkAllowlist('unrestricted', ['localhost:3700']),
    ).toBeNull();
    expect(effectiveNetworkAllowlist([], ['127.0.0.1:4000'])).toEqual([
      '127.0.0.1:4000',
    ]);
    expect(
      effectiveNetworkAllowlist(
        ['api.example.com:443'],
        ['localhost:3700', 'localhost:3700'],
      ),
    ).toEqual(['localhost:3700', 'api.example.com:443']);
  });

  it('derives exact host and default ports from runtime URLs', () => {
    expect(
      networkDestinationFromUrl('http://localhost:3700/api/app/demo'),
    ).toBe('localhost:3700');
    expect(networkDestinationFromUrl('https://EXAMPLE.com/path')).toBe(
      'example.com:443',
    );
    expect(networkDestinationFromUrl('postgres://user:pass@db.local/app')).toBe(
      'db.local:5432',
    );
    expect(networkDestinationFromUrl('http://[::1]:8080/path')).toBe(
      '[::1]:8080',
    );
  });
});
