import { describe, expect, it } from 'vitest';
import {
  dashboardBreakpointForWidth,
  dashboardPreviewScale,
  deriveDashboardLayouts,
  fitWidgetSize,
  type DashboardLayoutItem,
  type DashboardLayoutWidget,
} from './dashboard-layout';

const widget = (
  id: string,
  sortOrder: number,
  over: Partial<DashboardLayoutWidget> = {},
): DashboardLayoutWidget => ({
  id,
  sortOrder,
  defaultSize: { w: 4, h: 3 },
  supportedSizes: [],
  ...over,
});

const overlaps = (left: DashboardLayoutItem, right: DashboardLayoutItem) =>
  !(
    left.x + left.w <= right.x ||
    right.x + right.w <= left.x ||
    left.y + left.h <= right.y ||
    right.y + right.h <= left.y
  );

describe('dashboardBreakpointForWidth', () => {
  it('uses content-driven desktop, tablet, and mobile thresholds', () => {
    expect(dashboardBreakpointForWidth(1200)).toBe('desktop');
    expect(dashboardBreakpointForWidth(960)).toBe('desktop');
    expect(dashboardBreakpointForWidth(959)).toBe('tablet');
    expect(dashboardBreakpointForWidth(600)).toBe('tablet');
    expect(dashboardBreakpointForWidth(599)).toBe('mobile');
  });
});

describe('dashboardPreviewScale', () => {
  it('uniformly scales previews to fit standard editing workspaces', () => {
    expect(dashboardPreviewScale('desktop', 1024)).toBeCloseTo(1024 / 1200);
    expect(dashboardPreviewScale('tablet', 700)).toBeCloseTo(700 / 768);
    expect(dashboardPreviewScale('mobile', 320)).toBeCloseTo(320 / 390);
  });

  it('keeps larger layouts usable through horizontal scrolling', () => {
    expect(dashboardPreviewScale('desktop', 800)).toBe(0.8);
    expect(dashboardPreviewScale('tablet', 500)).toBeCloseTo(600 / 768);
    expect(dashboardPreviewScale('desktop', 1200)).toBe(1);
    expect(dashboardPreviewScale('desktop', 0)).toBe(1);
  });
});

describe('deriveDashboardLayouts', () => {
  it('keeps the persisted desktop layout and derives narrower layouts', () => {
    const layouts = deriveDashboardLayouts([widget('a', 0), widget('b', 1)], {
      desktop: [
        { id: 'a', x: 0, y: 0, w: 6, h: 2 },
        { id: 'b', x: 6, y: 0, w: 6, h: 2 },
      ],
    });

    expect(layouts.desktop).toEqual([
      { id: 'a', x: 0, y: 0, w: 6, h: 2 },
      { id: 'b', x: 6, y: 0, w: 6, h: 2 },
    ]);
    expect(layouts.tablet.every((item) => item.x + item.w <= 8)).toBe(true);
    expect(layouts.mobile.every((item) => item.x + item.w <= 4)).toBe(true);
    expect(layouts.mobile.every((item) => item.w === 4)).toBe(true);
    expect(overlaps(layouts.mobile[0], layouts.mobile[1])).toBe(false);
  });

  it('preserves saved narrow positions and fills only missing widgets', () => {
    const layouts = deriveDashboardLayouts(
      [widget('a', 0), widget('b', 1), widget('new', 2)],
      {
        desktop: [
          { id: 'a', x: 0, y: 0, w: 4, h: 3 },
          { id: 'b', x: 4, y: 0, w: 4, h: 3 },
          { id: 'new', x: 8, y: 0, w: 4, h: 3 },
        ],
        mobile: [
          { id: 'b', x: 0, y: 0, w: 4, h: 3 },
          { id: 'a', x: 0, y: 3, w: 4, h: 3 },
        ],
      },
    );

    expect(layouts.mobile.find((item) => item.id === 'b')).toEqual({
      id: 'b',
      x: 0,
      y: 0,
      w: 4,
      h: 3,
    });
    expect(layouts.mobile.find((item) => item.id === 'a')).toEqual({
      id: 'a',
      x: 0,
      y: 3,
      w: 4,
      h: 3,
    });
    expect(layouts.mobile.find((item) => item.id === 'new')?.y).toBe(6);
  });

  it('repairs duplicate, unknown, and colliding persisted items', () => {
    const layouts = deriveDashboardLayouts([widget('a', 0), widget('b', 1)], {
      desktop: [
        { id: 'a', x: 0, y: 0, w: 6, h: 2 },
        { id: 'a', x: 6, y: 0, w: 6, h: 2 },
        { id: 'missing', x: 0, y: 0, w: 6, h: 2 },
        { id: 'b', x: 0, y: 0, w: 6, h: 2 },
      ],
    });

    expect(layouts.desktop).toHaveLength(2);
    expect(overlaps(layouts.desktop[0], layouts.desktop[1])).toBe(false);
  });
});

describe('fitWidgetSize', () => {
  it('keeps free-form widgets inside each breakpoint', () => {
    expect(fitWidgetSize(widget('a', 0), { w: 8, h: 1 }, 'mobile')).toEqual({
      w: 4,
      h: 2,
    });
  });

  it('adapts declared footprints that are wider than a narrow grid', () => {
    const constrained = widget('a', 0, {
      supportedSizes: [
        { w: 6, h: 3 },
        { w: 12, h: 6 },
      ],
    });
    expect(fitWidgetSize(constrained, { w: 4, h: 5 }, 'mobile')).toEqual({
      w: 4,
      h: 6,
    });
  });
});
