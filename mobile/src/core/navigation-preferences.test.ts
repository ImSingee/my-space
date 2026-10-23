import { describe, expect, it } from 'vitest';
import {
  defaultNavigation,
  normalizeNavigation,
} from './navigation-preferences';
import { validateHandoff } from './security';

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

describe('dashboard WebView destination boundary', () => {
  const origin = 'https://hatch.example.test';
  const handoff = {
    url: `${origin}/api/auth/handoffs/consume`,
    ticket: 'a'.repeat(43),
    targetPath: '/mobile/dashboard/daily',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  it('binds dashboard handoffs to the requested dashboard and retains the app-only default', () => {
    expect(() => validateHandoff(origin, handoff, 'daily')).not.toThrow(
      'handoff',
    );
    expect(() => validateHandoff(origin, handoff, 'other')).toThrow('handoff');
    expect(() => validateHandoff(origin, handoff)).toThrow('handoff');
    expect(() =>
      validateHandoff(
        origin,
        { ...handoff, targetPath: '/mobile/dashboard/daily/../other' },
        'daily',
      ),
    ).toThrow('handoff');
    expect(() =>
      validateHandoff(
        origin,
        { ...handoff, url: 'https://evil.test/api/auth/handoffs/consume' },
        'daily',
      ),
    ).toThrow('handoff');
  });
});
