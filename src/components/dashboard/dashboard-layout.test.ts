import { describe, expect, it } from 'vitest';
import { buildWidgetLayout, snapUnits } from './dashboard-layout';

const placement = (
  over: Partial<Parameters<typeof buildWidgetLayout>[0][0]>,
) => ({
  id: 'w',
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  supportedSizes: [],
  ...over,
});

describe('buildWidgetLayout', () => {
  it('leaves free-form widgets resizable with only a small floor', () => {
    const [item] = buildWidgetLayout([placement({ supportedSizes: [] })]);
    expect(item.minW).toBe(2);
    expect(item.minH).toBe(2);
    expect(item.maxW).toBeUndefined();
    expect(item.maxH).toBeUndefined();
    // Undefined => RGL's default (resizable); we never force it off here.
    expect(item.isResizable).toBeUndefined();
  });

  it('clamps resizable widgets to their footprints bounding box', () => {
    const [item] = buildWidgetLayout([
      placement({
        supportedSizes: [
          { w: 3, h: 2 },
          { w: 6, h: 4 },
          { w: 4, h: 3 },
        ],
      }),
    ]);
    expect(item.minW).toBe(3);
    expect(item.maxW).toBe(6);
    expect(item.minH).toBe(2);
    expect(item.maxH).toBe(4);
    expect(item.isResizable).toBe(true);
  });

  it('locks a single-footprint widget against resizing', () => {
    const [item] = buildWidgetLayout([
      placement({ supportedSizes: [{ w: 4, h: 3 }] }),
    ]);
    expect(item.minW).toBe(4);
    expect(item.maxW).toBe(4);
    expect(item.minH).toBe(3);
    expect(item.maxH).toBe(3);
    expect(item.isResizable).toBe(false);
  });

  it('carries placement coordinates through unchanged', () => {
    const [item] = buildWidgetLayout([
      placement({ id: 'panel', x: 6, y: 2, w: 4, h: 3 }),
    ]);
    expect(item.i).toBe('panel');
    expect([item.x, item.y, item.w, item.h]).toEqual([6, 2, 4, 3]);
  });
});

describe('snapUnits', () => {
  it('returns the span unchanged for free-form widgets', () => {
    expect(snapUnits([], 5, 5)).toEqual({ w: 5, h: 5 });
    expect(snapUnits(undefined, 5, 5)).toEqual({ w: 5, h: 5 });
  });

  it('snaps to the nearest declared footprint', () => {
    const sizes = [
      { w: 3, h: 2 },
      { w: 6, h: 3 },
    ];
    expect(snapUnits(sizes, 5, 3)).toEqual({ w: 6, h: 3 });
    expect(snapUnits(sizes, 3, 2)).toEqual({ w: 3, h: 2 });
    expect(snapUnits(sizes, 4, 2)).toEqual({ w: 3, h: 2 });
  });
});
