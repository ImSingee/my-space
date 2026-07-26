/**
 * Pure layout helpers for the dashboard grid, kept free of React/CSS/RGL-runtime
 * imports so they can be unit-tested in Node. The grid component wires these into
 * react-grid-layout; the snapping rules themselves live here.
 */
import type { Layout } from 'react-grid-layout';
import {
  DASHBOARD_COLUMNS,
  FREEFORM_MIN_HEIGHT,
  FREEFORM_MIN_WIDTH,
  fitWidgetSize,
  supportedSizesForBreakpoint,
  type DashboardBreakpoint,
  type DashboardLayoutItem,
} from '~/lib/dashboard-layout';
import type { GridSize } from '~server/apps/manifest';

export type WidgetLayoutDefinition = {
  id: string;
  /** Declared footprints; empty means free-form resizing. */
  supportedSizes: GridSize[];
};

/**
 * Build one breakpoint's RGL layout, deriving each widget's resize
 * constraints from its declared footprints: clamp the handle to the footprints'
 * bounding box, and lock resizing entirely when only one footprint is supported.
 */
export function buildWidgetLayout(
  widgets: WidgetLayoutDefinition[],
  layout: DashboardLayoutItem[],
  breakpoint: DashboardBreakpoint,
): Layout[] {
  const widgetsById = new Map(widgets.map((widget) => [widget.id, widget]));
  const columns = DASHBOARD_COLUMNS[breakpoint];

  return layout.flatMap((item) => {
    const widget = widgetsById.get(item.id);
    if (!widget) return [];
    const base: Layout = {
      i: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    };
    const sizes = supportedSizesForBreakpoint(
      widget.supportedSizes,
      breakpoint,
    );
    if (sizes.length > 0) {
      base.minW = Math.min(...sizes.map((s) => s.w));
      base.maxW = Math.max(...sizes.map((s) => s.w));
      base.minH = Math.min(...sizes.map((s) => s.h));
      base.maxH = Math.max(...sizes.map((s) => s.h));
      base.isResizable = sizes.length > 1;
    } else {
      base.minW = Math.min(FREEFORM_MIN_WIDTH, columns);
      base.maxW = columns;
      base.minH = FREEFORM_MIN_HEIGHT;
    }
    return [base];
  });
}

/**
 * Snap a (possibly free-form) span to the widget's nearest declared footprint.
 * Returns the span unchanged when the widget declares no footprints.
 */
export function snapUnits(
  sizes: GridSize[] | undefined,
  w: number,
  h: number,
  breakpoint: DashboardBreakpoint,
): GridSize {
  return fitWidgetSize({ supportedSizes: sizes ?? [] }, { w, h }, breakpoint);
}
