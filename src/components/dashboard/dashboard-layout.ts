/**
 * Pure layout helpers for the dashboard grid, kept free of React/CSS/RGL-runtime
 * imports so they can be unit-tested in Node. The grid component wires these into
 * react-grid-layout; the snapping rules themselves live here.
 */
import type { Layout } from 'react-grid-layout';
import { type GridSize, snapToSupportedSize } from '~server/apps/manifest';

export type WidgetPlacement = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Declared footprints; empty means free-form resizing. */
  supportedSizes: GridSize[];
};

/** Free-form widgets keep a small floor so they can't shrink into uselessness. */
const FREEFORM_MIN_W = 2;
const FREEFORM_MIN_H = 2;

/**
 * Build the canonical-breakpoint RGL layout, deriving each widget's resize
 * constraints from its declared footprints: clamp the handle to the footprints'
 * bounding box, and lock resizing entirely when only one footprint is supported.
 */
export function buildWidgetLayout(items: WidgetPlacement[]): Layout[] {
  return items.map((item) => {
    const base: Layout = {
      i: item.id,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    };
    const sizes = item.supportedSizes;
    if (sizes.length > 0) {
      base.minW = Math.min(...sizes.map((s) => s.w));
      base.maxW = Math.max(...sizes.map((s) => s.w));
      base.minH = Math.min(...sizes.map((s) => s.h));
      base.maxH = Math.max(...sizes.map((s) => s.h));
      base.isResizable = sizes.length > 1;
    } else {
      base.minW = FREEFORM_MIN_W;
      base.minH = FREEFORM_MIN_H;
    }
    return base;
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
): GridSize {
  if (!sizes || sizes.length === 0) return { w, h };
  return snapToSupportedSize(sizes, { w, h }) ?? { w, h };
}
