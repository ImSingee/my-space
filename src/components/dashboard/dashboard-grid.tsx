import { Center, Loader } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Layout,
  type Layouts,
  Responsive,
  WidthProvider,
} from 'react-grid-layout';
import type { DashboardItem } from '~server/apps';
import { WidgetCard } from './widget-card';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import classes from './dashboard-grid.module.css';

const ResponsiveGrid = WidthProvider(Responsive);

// Breakpoint (min container width in px) → column count. The widest breakpoint
// keeps the 12-column system the stored layout and the server-side clamp use, so
// the canonical layout maps 1:1; narrower viewports reflow into fewer columns.
export const BREAKPOINTS = {
  lg: 1200,
  md: 996,
  sm: 768,
  xs: 480,
  xxs: 0,
} as const;
export const COLS: Record<string, number> = {
  lg: 12,
  md: 8,
  sm: 6,
  xs: 4,
  xxs: 2,
};
/** The breakpoint whose layout we persist (matches the stored 12-col coords). */
export const CANONICAL_BREAKPOINT = 'lg';
const ROW_HEIGHT = 80;
const MARGIN: [number, number] = [16, 16];

export function DashboardGrid({
  items,
  onRemove,
  onLayoutChange,
}: {
  items: DashboardItem[];
  onRemove: (id: string) => void;
  onLayoutChange: (layout: Layout[]) => void;
}) {
  // react-grid-layout measures container width on the client, so render it only
  // after mount to avoid SSR/hydration position mismatches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const layout = useMemo<Layout[]>(
    () =>
      items.map((item) => ({
        i: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        minW: 2,
        minH: 2,
      })),
    [items],
  );
  // Only the canonical breakpoint is fed a layout; RGL derives the narrower ones
  // by reflowing it into fewer columns.
  const layouts = useMemo<Layouts>(
    () => ({ [CANONICAL_BREAKPOINT]: layout }),
    [layout],
  );

  // Track the active breakpoint so we only persist edits made at the canonical
  // one. The grid mounts at the WidthProvider default width (which maps to lg),
  // and onBreakpointChange updates this whenever the container is narrower.
  const breakpointRef = useRef<string>(CANONICAL_BREAKPOINT);

  // Persist only on an actual drag/resize stop (a real user edit) AND only at
  // the canonical breakpoint, whose layout maps 1:1 to the stored 12-col coords.
  // This deliberately ignores react-grid-layout's other onLayoutChange triggers
  // (mount-time compaction, breakpoint switches, narrower-breakpoint reflows),
  // which would otherwise write a normalized or narrowed layout back to the
  // server with no user action — narrower breakpoints reflow for display only.
  const persistCanonicalEdit = (next: Layout[]) => {
    if (breakpointRef.current !== CANONICAL_BREAKPOINT) return;
    onLayoutChange(next);
  };

  if (!mounted) {
    return (
      <Center py={64}>
        <Loader />
      </Center>
    );
  }

  return (
    <ResponsiveGrid
      className={classes.grid}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      layouts={layouts}
      rowHeight={ROW_HEIGHT}
      margin={MARGIN}
      containerPadding={[0, 0]}
      compactType="vertical"
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      isBounded
      onBreakpointChange={(breakpoint) => {
        breakpointRef.current = breakpoint;
      }}
      onDragStop={persistCanonicalEdit}
      onResizeStop={persistCanonicalEdit}
    >
      {items.map((item) => (
        <div key={item.id} className={classes.cell}>
          <WidgetCard item={item} onRemove={() => onRemove(item.id)} />
        </div>
      ))}
    </ResponsiveGrid>
  );
}
