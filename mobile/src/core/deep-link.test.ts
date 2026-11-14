import { describe, expect, it } from 'vitest';
import {
  deepLinkFor,
  deliveryPlan,
  instanceLink,
  isDevClientLink,
  notificationUrlAction,
  webPageUrl,
  parseDeepLink,
  resolveLink,
  type LinkTarget,
} from './deep-link';

const origin = 'https://hatch.example';
const target = (value: string) => parseDeepLink(value)?.target ?? null;

describe('deep links', () => {
  it('names every page by its web path, with or without a host', () => {
    const pages: [string, LinkTarget][] = [
      ['hatch://', { kind: 'start' }],
      ['hatch:///', { kind: 'start' }],
      ['hatch://dashboard', { kind: 'tab', tab: 'dashboard' }],
      ['hatch://dashboards/', { kind: 'tab', tab: 'dashboard' }],
      ['hatch://dashboard/d_1', { kind: 'dashboard', id: 'd_1' }],
      ['hatch://mobile/dashboard/d_1', { kind: 'dashboard', id: 'd_1' }],
      ['hatch://apps', { kind: 'tab', tab: 'apps' }],
      ['hatch://app/sales', { kind: 'app', slug: 'sales' }],
      ['hatch://agent', { kind: 'tab', tab: 'agent' }],
      ['hatch://agent/s-42', { kind: 'conversation', id: 's-42' }],
      ['hatch://workflows', { kind: 'tab', tab: 'workflows' }],
      ['hatch://workflow/nightly', { kind: 'workflow', slug: 'nightly' }],
      ['hatch://notifications', { kind: 'notifications' }],
      ['hatch://notifications/n1', { kind: 'notification', id: 'n1' }],
      ['hatch://more', { kind: 'tab', tab: 'more' }],
      ['hatch://more/tabs', { kind: 'phone', page: 'tabs' }],
      ['hatch://more/instance', { kind: 'phone', page: 'instance' }],
      ['hatch://more/notifications', { kind: 'phone', page: 'notifications' }],
    ];
    for (const [link, page] of pages) {
      expect({ link, page: target(link) }).toEqual({ link, page });
      const triple = link.replace('hatch://', 'hatch:///');
      expect({ link: triple, page: target(triple) }).toEqual({
        link: triple,
        page,
      });
    }
  });

  it('opens an App at its own route', () => {
    expect(target('hatch://app/sales#/reports?period=month')).toEqual({
      kind: 'app',
      slug: 'sales',
      hash: '/reports?period=month',
    });
    expect(target('hatch://app/sales/embed/#/orders/7')).toEqual({
      kind: 'app',
      slug: 'sales',
      hash: '/orders/7',
    });
    // The route is the App's alone; other pages ignore a fragment.
    expect(target('hatch://agent/s1#x')).toEqual({
      kind: 'conversation',
      id: 's1',
    });
  });

  it('opens instance pages without a phone screen in the browser', () => {
    expect(target('hatch://app/sales/manage')).toEqual({
      kind: 'web',
      path: '/app/sales/manage',
    });
    expect(target('hatch://workflow/nightly/execution/r1#log')).toEqual({
      kind: 'web',
      path: '/workflow/nightly/execution/r1',
      hash: 'log',
    });
    expect(target('hatch://settings/providers')?.kind).toBe('web');
  });

  it('names the instance a page belongs to', () => {
    const instance = (link: string) => parseDeepLink(link)?.instance;
    expect(instance('hatch://app/sales')).toBeNull();
    expect(instance('hatch://app/sales?instance=hatch.example')).toBe(origin);
    expect(
      instance(`hatch://app/sales?instance=${encodeURIComponent(origin)}/`),
    ).toBe(origin);
    expect(instance('hatch://app/sales?x=1&instance=hatch.example:8443')).toBe(
      'https://hatch.example:8443',
    );
    // Plain HTTP is only for local development builds.
    const local = 'hatch://agent?instance=http%3A%2F%2Flocalhost%3A3000';
    expect(parseDeepLink(local)).toBeNull();
    expect(
      parseDeepLink(local, { allowDevelopmentLoopback: true })?.instance,
    ).toBe('http://localhost:3000');
  });

  it('refuses links that are malformed or reach past the pages', () => {
    const refused = [
      'hatch://api/rpc',
      'hatch://api/auth/handoffs/consume',
      'hatch://cli/authorize?user_code=X',
      'hatch://login',
      'hatch://app/bad!slug',
      'hatch://app/a.b',
      'hatch://agent/%2e%2e',
      'hatch://app/%2e%2e/api',
      'hatch://app/a%2Fb',
      'hatch://app/%252e%252e',
      'hatch://app/caf%C3%A9',
      'hatch://app//sales',
      'hatch://app/sales\\..',
      'hatch://app/sa les',
      'hatch://app/sales\u0000',
      'hatch://more/settings',
      'hatch://mobile/settings',
      `hatch://app/sales#${'x'.repeat(2049)}`,
      `hatch://${'a/'.repeat(2100)}`,
      'hatch://app/sales?instance=',
      'hatch://app/sales?instance=https://user:pw@hatch.example',
      'hatch://app/sales?instance=https://hatch.example/path',
      'hatch://app/sales?instance=http://hatch.example',
      'hatch://app/sales?instance=a.example&instance=b.example',
      'hatch://app/sales?instance=%E0%A4%A',
      'https://hatch.example/app/sales',
      'otherapp://app/sales',
    ];
    expect(refused.filter((link) => parseDeepLink(link) !== null)).toEqual([]);
  });

  it('leaves the development client its own links', () => {
    const link = 'hatch://expo-development-client/?url=http%3A%2F%2Fx';
    expect(isDevClientLink(link)).toBe(true);
    expect(parseDeepLink(link)).toBeNull();
    expect(isDevClientLink('hatch://app/expo-development-client')).toBe(false);
  });

  it('reads addresses on the instance in use as the same pages', () => {
    expect(instanceLink(`${origin}/app/sales#/reports`, origin)).toEqual({
      instance: origin,
      target: { kind: 'app', slug: 'sales', hash: '/reports' },
    });
    expect(instanceLink(`${origin}/agent/s1?x=1`, origin)?.target).toEqual({
      kind: 'conversation',
      id: 's1',
    });
    expect(instanceLink('https://elsewhere.example/app/sales', origin)).toBe(
      null,
    );
    expect(instanceLink(`https://u:p@hatch.example/app/sales`, origin)).toBe(
      null,
    );
    expect(instanceLink(`${origin}/api/auth/handoffs/complete`, origin)).toBe(
      null,
    );
    expect(instanceLink(`${origin}/app/%2e%2e/api/rpc`, origin)).toBeNull();
    expect(resolveLink('hatch://apps', null)?.target).toEqual({
      kind: 'tab',
      tab: 'apps',
    });
    expect(resolveLink(`${origin}/apps`, null)).toBeNull();
    expect(resolveLink(`${origin}/apps`, origin)?.target.kind).toBe('tab');
  });

  it('opens notification URLs for Hatch pages in the app', () => {
    const other = 'https://other.example';
    expect(
      notificationUrlAction('hatch://app/sales#/orders/7', origin),
    ).toEqual({
      open: 'page',
      link: {
        instance: origin,
        target: { kind: 'app', slug: 'sales', hash: '/orders/7' },
      },
    });
    expect(
      notificationUrlAction(`hatch://agent/s1?instance=other.example`, origin),
    ).toEqual({
      open: 'page',
      link: { instance: other, target: { kind: 'conversation', id: 's1' } },
    });
    expect(notificationUrlAction(`${origin}/workflow/nightly`, origin)).toEqual(
      {
        open: 'page',
        link: {
          instance: origin,
          target: { kind: 'workflow', slug: 'nightly' },
        },
      },
    );
    // A Hatch page without a phone screen still opens from the app.
    expect(
      notificationUrlAction('hatch://settings/providers?tab=keys', origin),
    ).toEqual({
      open: 'page',
      link: {
        instance: origin,
        target: {
          kind: 'web',
          path: '/settings/providers',
          search: '?tab=keys',
        },
      },
    });
    for (const url of [
      `${origin}/settings/providers`,
      'https://status.example.com/db-1',
      'mailto:ops@example.com',
    ])
      expect(notificationUrlAction(url, origin)).toEqual({
        open: 'outside',
        url,
      });
    // A deep link never leaves for the system, not even unreadable ones.
    for (const url of ['hatch://more/unknown', 'hatch://api/rpc'])
      expect(notificationUrlAction(url, origin)).toEqual({ open: 'none' });
  });

  it('opens pages without a phone screen at their full address', () => {
    const page = parseDeepLink('hatch://settings/providers?tab=keys#top');
    expect(page?.target.kind).toBe('web');
    if (page?.target.kind !== 'web') return;
    expect(webPageUrl(page.target, origin)).toBe(
      `${origin}/settings/providers?tab=keys#top`,
    );
  });

  it('writes links that read back as the same page', () => {
    const pages: LinkTarget[] = [
      { kind: 'start' },
      { kind: 'tab', tab: 'workflows' },
      { kind: 'dashboard', id: 'd1' },
      { kind: 'app', slug: 'sales', hash: '/reports?period=month' },
      { kind: 'conversation', id: 's1' },
      { kind: 'workflow', slug: 'nightly' },
      { kind: 'notifications' },
      { kind: 'notification', id: 'n1' },
      { kind: 'phone', page: 'instance' },
      { kind: 'web', path: '/settings/providers', hash: 'keys' },
      { kind: 'web', path: '/settings/users', search: '?q=ada' },
    ];
    for (const page of pages) {
      expect(parseDeepLink(deepLinkFor(page))).toEqual({
        instance: null,
        target: page,
      });
      expect(parseDeepLink(deepLinkFor(page, origin))?.instance).toBe(origin);
    }
  });

  it('switches only to signed-in instances and asks first for outside links', () => {
    const link = (instance: string | null) => ({
      instance,
      target: { kind: 'tab', tab: 'apps' } as const,
    });
    const other = 'https://other.example';
    const on = (current: string | null, instanceSignedIn = false) => ({
      origin: current,
      instanceSignedIn,
    });
    expect(deliveryPlan(link(null), false, on(origin))).toEqual({
      step: 'open',
    });
    expect(deliveryPlan(link(null), false, on(null))).toEqual({ step: 'hold' });
    expect(deliveryPlan(link(origin), false, on(origin))).toEqual({
      step: 'open',
    });
    expect(deliveryPlan(link(other), false, on(origin))).toEqual({
      step: 'unavailable',
      instance: other,
    });
    expect(deliveryPlan(link(other), false, on(null))).toEqual({
      step: 'unavailable',
      instance: other,
    });
    expect(deliveryPlan(link(other), false, on(origin, true))).toEqual({
      step: 'switch',
      instance: other,
      confirm: true,
    });
    expect(deliveryPlan(link(other), true, on(null, true))).toEqual({
      step: 'switch',
      instance: other,
      confirm: false,
    });
  });
});
