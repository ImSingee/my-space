import { Box } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import type { ReactNode } from 'react';
import {
  DASHBOARD_PREVIEW_WIDTH,
  dashboardPreviewScale,
  type DashboardBreakpoint,
} from '~/lib/dashboard-layout';
import classes from './dashboard-grid-stage.module.css';

/**
 * Keeps the grid under one stable DOM parent while editor chrome is toggled.
 * Moving it between separate view/edit branches would remount every widget
 * iframe and restart its runtime.
 */
export function DashboardGridStage({
  editing,
  previewBreakpoint,
  children,
}: {
  editing: boolean;
  previewBreakpoint: DashboardBreakpoint;
  children: (transformScale: number) => ReactNode;
}) {
  const { ref: measureViewport, width: availableWidth } =
    useElementSize<HTMLDivElement>();
  const { ref: measureCanvas, height: canvasHeight } =
    useElementSize<HTMLDivElement>();
  const targetWidth = DASHBOARD_PREVIEW_WIDTH[previewBreakpoint];
  const previewScale = dashboardPreviewScale(previewBreakpoint, availableWidth);
  const scaledWidth = targetWidth * previewScale;
  const scaledHeight = canvasHeight * previewScale;

  return (
    <Box
      className={editing ? classes.stage : undefined}
      data-preview-active={editing || undefined}
    >
      <Box
        ref={measureViewport}
        className={editing ? classes.viewport : undefined}
      >
        <Box
          className={editing ? classes.frame : undefined}
          style={
            editing
              ? {
                  width: scaledWidth,
                  height: canvasHeight > 0 ? scaledHeight : undefined,
                }
              : undefined
          }
        >
          <Box
            ref={measureCanvas}
            className={editing ? classes.canvas : undefined}
            style={
              editing
                ? {
                    width: targetWidth,
                    transform: `scale(${previewScale})`,
                  }
                : undefined
            }
            data-breakpoint={editing ? previewBreakpoint : undefined}
            data-preview-scale={editing ? previewScale : undefined}
          >
            {children(editing ? previewScale : 1)}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
