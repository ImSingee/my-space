import { Center, Loader } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useMemo } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import type { DashboardItem } from '~server/dashboards';
import {
  DASHBOARD_COLUMNS,
  dashboardBreakpointForWidth,
  type DashboardBreakpoint,
  type DashboardLayoutItem,
  type DashboardLayouts,
} from '~/lib/dashboard-layout';
import { buildWidgetLayout, snapUnits } from './dashboard-layout';
import { WidgetCard } from './widget-card';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import classes from './dashboard-grid.module.css';

const ROW_HEIGHT = 80;

export function DashboardGrid({
  items,
  layouts,
  editing,
  previewBreakpoint,
  onRemove,
  onLayoutCommit,
  removeDisabled = false,
  interactionDisabled = false,
  transformScale = 1,
  refreshSignal,
}: {
  items: DashboardItem[];
  layouts: DashboardLayouts;
  editing: boolean;
  previewBreakpoint?: DashboardBreakpoint;
  onRemove: (id: string) => void;
  onLayoutCommit: (
    breakpoint: DashboardBreakpoint,
    layout: DashboardLayoutItem[],
  ) => void;
  removeDisabled?: boolean;
  interactionDisabled?: boolean;
  transformScale?: number;
  /** Bumped by dashboard-wide manual or automatic refreshes. */
  refreshSignal?: number;
}) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const breakpoint = previewBreakpoint ?? dashboardBreakpointForWidth(width);
  const activeLayout = layouts[breakpoint];

  const layout = useMemo<Layout[]>(
    () => buildWidgetLayout(items, activeLayout, breakpoint),
    [activeLayout, breakpoint, items],
  );

  // Look up a widget's declared footprints by placement id for the resize-snap
  // handlers (which only get the RGL layout item, not the DashboardItem).
  const sizesById = useMemo(
    () => new Map(items.map((item) => [item.id, item.supportedSizes])),
    [items],
  );
  const geometryById = useMemo(
    () => new Map(activeLayout.map((item) => [item.id, item])),
    [activeLayout],
  );

  const commit = (next: Layout[]) =>
    onLayoutCommit(
      breakpoint,
      next.map((item) => ({
        id: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      })),
    );

  return (
    <div
      ref={ref}
      className={classes.measure}
      data-breakpoint={breakpoint}
      data-editing={editing || undefined}
    >
      {width > 0 ? (
        <GridLayout
          className={classes.grid}
          width={width}
          cols={DASHBOARD_COLUMNS[breakpoint]}
          layout={layout}
          rowHeight={ROW_HEIGHT}
          margin={breakpoint === 'mobile' ? [12, 12] : [16, 16]}
          containerPadding={[0, 0]}
          compactType="vertical"
          draggableHandle=".widget-drag-handle"
          draggableCancel=".widget-no-drag"
          isDraggable={editing && !interactionDisabled}
          isResizable={editing && !interactionDisabled}
          isBounded
          transformScale={transformScale}
          onDragStop={commit}
          onResize={(_next, _oldItem, newItem, placeholder) => {
            const snapped = snapUnits(
              sizesById.get(newItem.i),
              newItem.w,
              newItem.h,
              breakpoint,
            );
            newItem.w = snapped.w;
            newItem.h = snapped.h;
            placeholder.w = snapped.w;
            placeholder.h = snapped.h;
          }}
          onResizeStop={(next) =>
            commit(
              next.map((item) => {
                const snapped = snapUnits(
                  sizesById.get(item.i),
                  item.w,
                  item.h,
                  breakpoint,
                );
                return { ...item, ...snapped };
              }),
            )
          }
        >
          {items.map((item) => {
            const geometry = geometryById.get(item.id);
            if (!geometry) return null;
            return (
              <div key={item.id} className={classes.cell}>
                <WidgetCard
                  item={item}
                  geometry={geometry}
                  editing={editing}
                  removeDisabled={removeDisabled}
                  onRemove={() => onRemove(item.id)}
                  refreshSignal={refreshSignal}
                />
              </div>
            );
          })}
        </GridLayout>
      ) : (
        <Center py={64}>
          <Loader size="sm" />
        </Center>
      )}
    </div>
  );
}
