import { describe, expect, it } from 'vitest';
import {
  decideLoad,
  decideNewWindow,
  externalUrl,
  stepsBackInPage,
  type SurfaceContext,
} from './surface-navigation';

const origin = 'https://hatch.example';
const ticket = 'T1cketValueThatIsLongEnough_0123';
const app: SurfaceContext = {
  origin,
  target: '/app/notes/embed/',
  handoff: {
    ticket,
    completionUrl: `${origin}/api/auth/handoffs/complete`,
  },
  signedIn: true,
  ready: true,
  canRoute: false,
};
const dashboard: SurfaceContext = {
  ...app,
  target: '/mobile/dashboard/default',
  canRoute: true,
};

describe('surface navigation', () => {
  it('keeps the sign-in handshake inside the view and lets nothing else out', () => {
    const signingIn = { ...app, signedIn: false, ready: false };
    const top = (url: string, navigationType = 'other') =>
      decideLoad({ url, isTopFrame: true, navigationType }, signingIn).action;
    expect(top(`${origin}/api/auth/handoffs/consume`)).toBe('load');
    expect(top(`${origin}/api/auth/handoffs/complete`)).toBe('load');
    expect(top(`${origin}/app/notes/embed/`)).toBe('block');
    expect(top('https://elsewhere.example/', 'click')).toBe('block');
    expect(decideNewWindow('https://elsewhere.example/', signingIn)).toEqual({
      action: 'block',
    });
  });

  it('keeps the App’s own pages and opens Hatch pages natively, App routes included', () => {
    const top = (url: string, context = app, navigationType = 'click') =>
      decideLoad({ url, isTopFrame: true, navigationType }, context);
    expect(top(`${origin}/app/notes/embed/#/detail`).action).toBe('load');
    expect(top(`${origin}/app/notes/embed/page.html?x=1`).action).toBe('load');
    expect(top(`${origin}/app/reading#/books/7`, dashboard)).toEqual({
      action: 'route',
      link: {
        instance: origin,
        target: { kind: 'app', slug: 'reading', hash: '/books/7' },
      },
    });
    expect(top(`${origin}/agent/s1`, dashboard)).toEqual({
      action: 'route',
      link: { instance: origin, target: { kind: 'conversation', id: 's1' } },
    });
    // Script navigation opens a page only once this one is showing.
    const loading = { ...dashboard, ready: false };
    expect(top(`${origin}/agent/s1`, loading, 'other').action).toBe('block');
    expect(top(`${origin}/agent/s1`, dashboard, 'formsubmit').action).toBe(
      'block',
    );
    // Pages without a screen here need a browser session; they stay put.
    expect(top(`${origin}/app/reading/manage`, dashboard).action).toBe('block');
    expect(top(`${origin}/api/rpc`, dashboard).action).toBe('block');
    expect(top(`${origin}/dashboard`).action).toBe('block');
    expect(top(`${origin}/login`).action).toBe('expired');
  });

  it('opens Hatch links here instead of through the system', () => {
    const link = 'hatch://app/reading?instance=other.example#/books';
    expect(decideNewWindow(link, dashboard)).toEqual({
      action: 'route',
      link: {
        instance: 'https://other.example',
        target: { kind: 'app', slug: 'reading', hash: '/books' },
      },
    });
    expect(
      decideLoad({ url: link, isTopFrame: true, navigationType: 'click' }, app),
    ).toEqual({ action: 'block' });
    expect(decideNewWindow('hatch://api/rpc', dashboard)).toEqual({
      action: 'block',
    });
    // Pages without a screen here stay put, as with the instance's addresses.
    expect(decideNewWindow('hatch://settings/providers', dashboard)).toEqual({
      action: 'block',
    });
    // The handoff ticket never travels in a Hatch link either, however
    // encoded, nor in an address on this instance.
    const encoded = ticket.replace(/^T/, '%54');
    for (const url of [
      `hatch://app/reading#${ticket}`,
      `hatch://app/reading#${encoded}`,
      `hatch://agent/s1?q=${ticket}`,
      `${origin}/app/reading#${ticket}`,
    ])
      expect({
        url,
        decision: decideLoad(
          { url, isTopFrame: true, navigationType: 'click' },
          dashboard,
        ),
      }).toEqual({ url, decision: { action: 'block' } });
    expect(
      decideNewWindow('hatch://app/reading', { ...dashboard, signedIn: false }),
    ).toEqual({ action: 'block' });
  });

  it('sends followed cross-site links to the system browser, never while loading', () => {
    const top = (navigationType: string | undefined, context = app) =>
      decideLoad(
        {
          url: 'https://docs.example/a?b=1#c',
          isTopFrame: true,
          navigationType,
        },
        context,
      );
    const leaves = { action: 'external', url: 'https://docs.example/a?b=1#c' };
    expect(top('click')).toEqual(leaves);
    // Android reports neither frame nor navigation type.
    expect(top(undefined)).toEqual(leaves);
    expect(top('other')).toEqual(leaves);
    expect(top('other', { ...app, ready: false }).action).toBe('block');
    expect(top('formsubmit').action).toBe('block');
  });

  it('opens a link followed inside an embedded frame but never a frame that loads itself', () => {
    const frame = (url: string, navigationType: string) =>
      decideLoad({ url, isTopFrame: false, navigationType }, app).action;
    expect(frame('https://maps.example/embed', 'other')).toBe('block');
    expect(frame('https://maps.example/place', 'click')).toBe('external');
    expect(frame(`${origin}/app/notes/embed/frame.html`, 'other')).toBe('load');
    expect(frame('about:srcdoc', 'other')).toBe('load');
    expect(
      decideLoad({ url: 'about:srcdoc', isTopFrame: true }, dashboard).action,
    ).toBe('block');
  });

  it('opens every new window in the system browser, even the App’s own pages', () => {
    for (const [url, context] of [
      [`${origin}/app/notes/embed/?from=x#/y`, app],
      [`${origin}/app/reading/embed/`, dashboard],
      [`${origin}/workflow/weekly`, app],
      ['http://lan.example:8080/x', app],
    ] as const)
      expect(decideNewWindow(url, context)).toEqual({
        action: 'external',
        url,
      });
  });

  it('hands any other scheme to the app that owns it, under the same rules', () => {
    const load = (url: string, request = {}, context = app) =>
      decideLoad({ url, ...request }, context).action;
    for (const url of [
      'someapp://open/item?id=1',
      'mailto:a@example.com',
      'tel:+15550100',
      'vnc://user:secret@host.example/',
    ]) {
      expect(decideNewWindow(url, app)).toEqual({ action: 'external', url });
      expect(load(url, { isTopFrame: true, navigationType: 'click' })).toBe(
        'external',
      );
      // Android reports neither frame nor navigation type.
      expect(load(url)).toBe('external');
      expect(load(url, { isTopFrame: false, navigationType: 'click' })).toBe(
        'external',
      );
      // Never from a frame that loads itself, a page still loading, or sign-in.
      expect(load(url, { isTopFrame: false, navigationType: 'other' })).toBe(
        'block',
      );
      expect(
        load(
          url,
          { isTopFrame: true, navigationType: 'other' },
          { ...app, ready: false },
        ),
      ).toBe('block');
      expect(
        decideNewWindow(url, { ...app, signedIn: false, ready: false }).action,
      ).toBe('block');
    }
    for (const url of [
      `someapp://open?t=${ticket}`,
      `someapp://open?t=%54${ticket.slice(1)}`,
    ])
      expect(decideNewWindow(url, app).action).toBe('block');
  });

  it('never lets credentials, handoff pages, the ticket or document schemes leave', () => {
    const urls = [
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'file:///etc/hosts',
      'blob:https://hatch.example/1',
      'about:blank',
      'not a url',
      'https://user:secret@docs.example/',
      'https://user@docs.example/',
      `${origin}/api/auth/handoffs/complete`,
      `${origin}/api/auth/handoffs/consume?ticket=${ticket}`,
      `https://docs.example/?t=${ticket}`,
      `https://docs.example/?t=${encodeURIComponent(ticket).replace('T', '%54')}`,
    ];
    const leaked = urls.filter(
      (url) =>
        decideNewWindow(url, app).action !== 'block' ||
        decideLoad({ url, isTopFrame: true, navigationType: 'click' }, app)
          .action === 'external',
    );
    expect(leaked).toEqual([]);
  });

  it('keeps partially encoded tickets private even alongside malformed escapes', () => {
    const escaped = `%54${ticket.slice(1)}`;
    for (const value of [
      `https://docs.example/?ticket=${escaped}&bad=%ZZ`,
      `https://docs.example/?bad=%FF#${escaped}`,
      `https://docs.example/?ticket=%2554${ticket.slice(1)}`,
    ]) {
      expect(externalUrl(value, app)).toBeNull();
      expect(decideNewWindow(value, app).action).toBe('block');
      expect(
        decideLoad({ url: value, navigationType: 'click' }, app).action,
      ).toBe('block');
    }
  });

  it('blocks encoded handoff paths at the shared browser boundary', () => {
    for (const path of [
      '/api/auth/%68andoffs/consume?ticket=another-ticket',
      '/api%2fauth%2fhandoffs%2fcomplete',
      '/api/auth/%2568andoffs/consume',
      '/api/elsewhere/%2e%2e/auth/%68andoffs/consume',
      '/api/auth%5chandoffs%5cconsume',
      '/api/auth/%68andoffs',
    ]) {
      expect(externalUrl(`${origin}${path}`, app)).toBeNull();
      expect(decideNewWindow(`${origin}${path}`, app).action).toBe('block');
    }
    expect(
      externalUrl('https://docs.example/help%20page?price=100%25', app),
    ).toBe('https://docs.example/help%20page?price=100%25');
  });

  it('allows blank initialization and subframes without blanking a signed-in surface', () => {
    expect(
      decideLoad(
        { url: 'about:blank', isTopFrame: true },
        {
          ...app,
          signedIn: false,
          ready: false,
        },
      ).action,
    ).toBe('load');
    expect(
      decideLoad({ url: 'about:blank', isTopFrame: false }, app).action,
    ).toBe('load');
    expect(
      decideLoad({ url: 'about:blank', isTopFrame: true }, app).action,
    ).toBe('block');
    expect(decideLoad({ url: 'about:blank' }, app).action).toBe('block');
  });

  it('lets the page take only a single step back and never holds other removals', () => {
    expect(stepsBackInPage({ type: 'GO_BACK' })).toBe(true);
    expect(stepsBackInPage({ type: 'POP', payload: { count: 1 } })).toBe(true);
    expect(stepsBackInPage({ type: 'POP', payload: { count: 2 } })).toBe(false);
    for (const type of ['RESET', 'POP_TO_TOP', 'NAVIGATE', 'REPLACE'])
      expect(stepsBackInPage({ type })).toBe(false);
  });
});
