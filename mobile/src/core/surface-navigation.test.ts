import { describe, expect, it } from 'vitest';
import {
  decideLoad,
  decideNewWindow,
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
  canOpenApp: false,
};
const dashboard: SurfaceContext = {
  ...app,
  target: '/mobile/dashboard/default',
  canOpenApp: true,
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

  it('keeps the App’s own pages and opens Apps natively from a dashboard', () => {
    const top = (url: string, context = app) =>
      decideLoad({ url, isTopFrame: true, navigationType: 'click' }, context);
    expect(top(`${origin}/app/notes/embed/#/detail`).action).toBe('load');
    expect(top(`${origin}/app/notes/embed/page.html?x=1`).action).toBe('load');
    expect(top(`${origin}/app/reading`, dashboard)).toEqual({
      action: 'app',
      slug: 'reading',
    });
    expect(top(`${origin}/dashboard`).action).toBe('block');
    expect(top(`${origin}/login`).action).toBe('expired');
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
    const browser = { action: 'browser', url: 'https://docs.example/a?b=1#c' };
    expect(top('click')).toEqual(browser);
    // Android reports neither frame nor navigation type.
    expect(top(undefined)).toEqual(browser);
    expect(top('other')).toEqual(browser);
    expect(top('other', { ...app, ready: false }).action).toBe('block');
    expect(top('formsubmit').action).toBe('block');
  });

  it('opens a link followed inside an embedded frame but never a frame that loads itself', () => {
    const frame = (url: string, navigationType: string) =>
      decideLoad({ url, isTopFrame: false, navigationType }, app).action;
    expect(frame('https://maps.example/embed', 'other')).toBe('block');
    expect(frame('https://maps.example/place', 'click')).toBe('browser');
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
      expect(decideNewWindow(url, context)).toEqual({ action: 'browser', url });
  });

  it('never lets credentials, handoff pages, the ticket or other schemes leave', () => {
    const urls = [
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'file:///etc/hosts',
      'blob:https://hatch.example/1',
      'about:blank',
      'mailto:a@example.com',
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
          .action === 'browser',
    );
    expect(leaked).toEqual([]);
  });

  it('lets the page take only a single step back and never holds other removals', () => {
    expect(stepsBackInPage({ type: 'GO_BACK' })).toBe(true);
    expect(stepsBackInPage({ type: 'POP', payload: { count: 1 } })).toBe(true);
    expect(stepsBackInPage({ type: 'POP', payload: { count: 2 } })).toBe(false);
    for (const type of ['RESET', 'POP_TO_TOP', 'NAVIGATE', 'REPLACE'])
      expect(stepsBackInPage({ type })).toBe(false);
  });
});
