import { describe, expect, it } from 'vitest';
import { formatHatchLink, hatchLinkWebUrl, parseHatchLink } from './deep-link';

const origin = 'https://hatch.example';

describe('Hatch deep links', () => {
  it('name the page the instance serves at the same path', () => {
    expect(hatchLinkWebUrl('hatch://app/sales#/orders/7', origin)).toBe(
      `${origin}/app/sales#/orders/7`,
    );
    expect(hatchLinkWebUrl('hatch:///apps?scope=all', origin)).toBe(
      `${origin}/apps?scope=all`,
    );
    expect(hatchLinkWebUrl('hatch://', origin)).toBe(`${origin}/`);
    expect(
      hatchLinkWebUrl('hatch://agent/s1?instance=other.example', origin),
    ).toBe('https://other.example/agent/s1');
    expect(
      hatchLinkWebUrl('hatch://agent?instance=http://localhost:3000', origin, {
        allowLoopbackHttp: true,
      }),
    ).toBe('http://localhost:3000/agent');
  });

  it('refuse anything that is not a page on an HTTPS instance', () => {
    for (const link of [
      'https://hatch.example/app/sales',
      'hatch://api/rpc',
      'hatch://cli/authorize',
      'hatch://login',
      'hatch://app/%2e%2e/api',
      'hatch://app/a%2Fb',
      'hatch://app//sales',
      'hatch://app/sa les',
      'hatch://expo-development-client/?url=x',
      'hatch://agent?instance=http://localhost:3000',
      'hatch://agent?instance=https://hatch.example/path',
      'hatch://agent?instance=https://u:p@hatch.example',
      'hatch://agent?instance=a.example&instance=b.example',
      `hatch://app/x#${'y'.repeat(2049)}`,
    ])
      expect({ link, parsed: parseHatchLink(link) }).toEqual({
        link,
        parsed: null,
      });
  });

  it('write links that read back as the same page', () => {
    const page = {
      segments: ['settings', 'users'],
      search: '?q=ada',
      hash: 'top',
    };
    expect(parseHatchLink(formatHatchLink(page, origin))).toEqual({
      instance: origin,
      ...page,
    });
  });
});
