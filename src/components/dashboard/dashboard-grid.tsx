import { Center, Loader } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import GridLayout, { type Layout, WidthProvider } from 'react-grid-layout';
import type { DashboardItem } from '~server/subapps';
import { WidgetCard } from './widget-card';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import classes from './dashboard-grid.module.css';

const ResponsiveGrid = WidthProvider(GridLayout);

const COLS = 12;
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
      layout={layout}
      cols={COLS}
      rowHeight={ROW_HEIGHT}
      margin={MARGIN}
      containerPadding={[0, 0]}
      compactType="vertical"
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      isBounded
      onDragStop={onLayoutChange}
      onResizeStop={onLayoutChange}
    >
      {items.map((item) => (
        <div key={item.id} className={classes.cell}>
          <WidgetCard item={item} onRemove={() => onRemove(item.id)} />
        </div>
      ))}
    </ResponsiveGrid>
  );
}
