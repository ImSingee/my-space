import { describe, expect, it } from 'vitest';
import {
  defaultNavigation,
  normalizeNavigation,
} from './navigation-preferences';
import {
  appDestination,
  dashboardDestination,
  destinationUrl,
} from './security';

describe('device navigation preferences', () => {
  it('preserves ordered visible tabs and start page across serialization', () => {
    const p = {
      order: ['agent', 'apps', 'dashboard', 'workflows'],
      visible: ['agent', 'dashboard'],
      defaultTab: 'agent',
    };
    expect(normalizeNavigation(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });
  it('falls back to the first visible tab when the default is hidden, or More when all are hidden', () => {
    expect(
      normalizeNavigation({
        ...defaultNavigation,
        order: ['apps', 'agent', 'dashboard'],
        visible: ['apps', 'agent'],
      }).defaultTab,
    ).toBe('apps');
    expect(
      normalizeNavigation({ ...defaultNavigation, visible: [] }).defaultTab,
    ).toBe('more');
  });
  it('repairs unknown and duplicated tabs without removing newly supported tabs', () => {
    expect(
      normalizeNavigation({
        order: ['agent', 'unknown', 'agent'],
        visible: ['agent', 'unknown'],
        defaultTab: 'unknown',
      }),
    ).toEqual({
      order: ['agent', 'dashboard', 'apps', 'workflows'],
      visible: ['agent'],
      defaultTab: 'agent',
    });
    expect(normalizeNavigation(null)).toEqual(defaultNavigation);
  });
});

describe('WebView destinations after a resource-free handoff', () => {
  const origin = 'https://hatch.example.test';
  it('opens encoded dashboard canvases and pinned App entries on this instance only', () => {
    expect(destinationUrl(origin, dashboardDestination('daily'))).toBe(
      `${origin}/mobile/dashboard/daily`,
    );
    expect(destinationUrl(origin, dashboardDestination('a/../admin'))).toBe(
      `${origin}/mobile/dashboard/a%2F..%2Fadmin`,
    );
    expect(destinationUrl(origin, appDestination('notes', '/today'))).toBe(
      `${origin}/app/notes/embed/#/today`,
    );
    expect(destinationUrl(origin, appDestination('notes', '#/archive'))).toBe(
      `${origin}/app/notes/embed/#/archive`,
    );
    expect(destinationUrl(origin, appDestination('notes', ''))).toBe(
      `${origin}/app/notes/embed/`,
    );
    for (const slug of ['', '../admin', 'notes/embed', '//evil.test', 'a b'])
      expect(() => appDestination(slug)).toThrow('Invalid App address');
    expect(() => dashboardDestination('')).toThrow('Invalid Dashboard');
    expect(() =>
      destinationUrl(origin, { path: '//evil.test/mobile/dashboard/x' }),
    ).toThrow('Invalid page address');
  });
});
