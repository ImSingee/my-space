import { describe, expect, it } from 'vitest';
import {
  dashboardWidgetIdsToRemove,
  dashboardWidgetKey,
} from './dashboard-widget';

describe('dashboardWidgetKey', () => {
  it('distinguishes identities even when ids contain separators', () => {
    expect(dashboardWidgetKey({ appId: 'a:b', widgetId: 'c' })).not.toBe(
      dashboardWidgetKey({ appId: 'a', widgetId: 'b:c' }),
    );
  });
});

describe('dashboardWidgetIdsToRemove', () => {
  it('excludes placements resolved as retained by the server', () => {
    expect(
      dashboardWidgetIdsToRemove(['removed', 're-added'], ['re-added']),
    ).toEqual(['removed']);
  });
});
