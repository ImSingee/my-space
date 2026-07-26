import { describe, expect, it } from 'vitest';
import { buildWidgetLayout, snapUnits } from './dashboard-layout';

const widget = (supportedSizes: { w: number; h: number }[] = []) => ({
  id: 'w',
  supportedSizes,
});

const placement = {
  id: 'w',
  x: 0,
  y: 0,
  w: 4,
  h: 3,
};

describe('buildWidgetLayout', () => {
  it('keeps free-form desktop widgets resizable within the active grid', () => {
    const [item] = buildWidgetLayout([widget()], [placement], 'desktop');
    expect(item.minW).toBe(2);
    expect(item.maxW).toBe(12);
    expect(item.minH).toBe(2);
    expect(item.maxH).toBeUndefined();
    expect(item.isResizable).toBeUndefined();
  });

  it('clamps widgets to the active breakpoint footprints', () => {
    const sizes = [
      { w: 3, h: 2 },
      { w: 6, h: 4 },
      { w: 4, h: 3 },
    ];
    const [item] = buildWidgetLayout([widget(sizes)], [placement], 'desktop');
    expect(item.minW).toBe(3);
    expect(item.maxW).toBe(6);
    expect(item.minH).toBe(2);
    expect(item.maxH).toBe(4);
    expect(item.isResizable).toBe(true);
  });

  it('adapts footprints that are wider than the mobile grid', () => {
    const [item] = buildWidgetLayout(
      [
        widget([
          { w: 6, h: 3 },
          { w: 12, h: 6 },
        ]),
      ],
      [{ ...placement, w: 4 }],
      'mobile',
    );
    expect(item.minW).toBe(4);
    expect(item.maxW).toBe(4);
    expect(item.minH).toBe(3);
    expect(item.maxH).toBe(6);
    expect(item.isResizable).toBe(true);
  });

  it('locks a single-footprint widget against resizing', () => {
    const [item] = buildWidgetLayout(
      [widget([{ w: 4, h: 3 }])],
      [placement],
      'desktop',
    );
    expect(item.minW).toBe(4);
    expect(item.maxW).toBe(4);
    expect(item.minH).toBe(3);
    expect(item.maxH).toBe(3);
    expect(item.isResizable).toBe(false);
  });

  it('carries persisted coordinates through unchanged', () => {
    const [item] = buildWidgetLayout(
      [widget()],
      [{ ...placement, id: 'w', x: 6, y: 2, w: 4, h: 3 }],
      'desktop',
    );
    expect([item.x, item.y, item.w, item.h]).toEqual([6, 2, 4, 3]);
  });
});

describe('snapUnits', () => {
  it('keeps free-form sizes inside the active grid', () => {
    expect(snapUnits([], 5, 5, 'desktop')).toEqual({ w: 5, h: 5 });
    expect(snapUnits(undefined, 5, 5, 'mobile')).toEqual({ w: 4, h: 5 });
  });

  it('snaps to the nearest declared footprint', () => {
    const sizes = [
      { w: 3, h: 2 },
      { w: 6, h: 3 },
    ];
    expect(snapUnits(sizes, 5, 3, 'desktop')).toEqual({ w: 6, h: 3 });
    expect(snapUnits(sizes, 3, 2, 'desktop')).toEqual({ w: 3, h: 2 });
    expect(snapUnits(sizes, 4, 2, 'desktop')).toEqual({ w: 3, h: 2 });
  });
});
