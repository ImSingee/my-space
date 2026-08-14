import { snapToSupportedSize, type GridSize } from '~/server/apps/manifest';

export const DASHBOARD_BREAKPOINTS = {
  desktop: 960,
  tablet: 600,
  mobile: 0,
} as const;

export type DashboardBreakpoint = keyof typeof DASHBOARD_BREAKPOINTS;

export const DASHBOARD_BREAKPOINT_ORDER = [
  'desktop',
  'tablet',
  'mobile',
] as const satisfies readonly DashboardBreakpoint[];

export const DASHBOARD_COLUMNS: Record<DashboardBreakpoint, number> = {
  desktop: 12,
  tablet: 8,
  mobile: 4,
};

export const DASHBOARD_PREVIEW_WIDTH: Record<DashboardBreakpoint, number> = {
  desktop: 1200,
  tablet: 768,
  mobile: 390,
};

export function dashboardPreviewScale(
  breakpoint: DashboardBreakpoint,
  availableWidth: number,
): number {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  const targetWidth = DASHBOARD_PREVIEW_WIDTH[breakpoint];
  const minimumWidth = DASHBOARD_BREAKPOINTS[breakpoint];
  return Math.min(1, Math.max(availableWidth, minimumWidth) / targetWidth);
}

export const DASHBOARD_MAX_HEIGHT = 100;
export const DASHBOARD_MAX_Y = 10_000;
export const FREEFORM_MIN_WIDTH = 2;
export const FREEFORM_MIN_HEIGHT = 2;

export type DashboardLayoutItem = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DashboardLayoutWidget = {
  id: string;
  sortOrder: number;
  defaultSize: GridSize;
  supportedSizes: GridSize[];
};

export type DashboardLayouts = Record<
  DashboardBreakpoint,
  DashboardLayoutItem[]
>;

export type PersistedDashboardLayouts = Partial<DashboardLayouts>;

function clampInt(value: number, min: number, max: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, rounded));
}

function compareLayoutItems(
  left: DashboardLayoutItem,
  right: DashboardLayoutItem,
): number {
  return (
    left.y - right.y || left.x - right.x || left.id.localeCompare(right.id)
  );
}

function overlaps(
  left: DashboardLayoutItem,
  right: DashboardLayoutItem,
): boolean {
  return !(
    left.x + left.w <= right.x ||
    right.x + right.w <= left.x ||
    left.y + left.h <= right.y ||
    right.y + right.h <= left.y
  );
}

function nearestXPositions(preferredX: number, maxX: number): number[] {
  return Array.from({ length: maxX + 1 }, (_, x) => x).sort(
    (left, right) =>
      Math.abs(left - preferredX) - Math.abs(right - preferredX) ||
      left - right,
  );
}

function placeWithoutCollision(
  item: DashboardLayoutItem,
  occupied: DashboardLayoutItem[],
  columns: number,
): DashboardLayoutItem {
  const maxX = Math.max(0, columns - item.w);
  const preferredX = clampInt(item.x, 0, maxX);
  const positions = nearestXPositions(preferredX, maxX);

  for (
    let y = clampInt(item.y, 0, DASHBOARD_MAX_Y);
    y <= DASHBOARD_MAX_Y;
    y += 1
  ) {
    for (const x of positions) {
      const candidate = { ...item, x, y };
      if (!occupied.some((other) => overlaps(candidate, other))) {
        return candidate;
      }
    }
  }

  return { ...item, x: preferredX, y: DASHBOARD_MAX_Y };
}

export function dashboardBreakpointForWidth(
  width: number,
): DashboardBreakpoint {
  if (width >= DASHBOARD_BREAKPOINTS.desktop) return 'desktop';
  if (width >= DASHBOARD_BREAKPOINTS.tablet) return 'tablet';
  return 'mobile';
}

export function supportedSizesForBreakpoint(
  sizes: GridSize[],
  breakpoint: DashboardBreakpoint,
): GridSize[] {
  if (sizes.length === 0) return [];

  const columns = DASHBOARD_COLUMNS[breakpoint];
  const fitting = sizes.filter((size) => size.w <= columns);
  const source = fitting.length > 0 ? fitting : sizes;
  const seen = new Set<string>();
  const result: GridSize[] = [];

  for (const size of source) {
    const fitted = { w: Math.min(columns, size.w), h: size.h };
    const key = `${fitted.w}x${fitted.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fitted);
  }

  return result;
}

export function fitWidgetSize(
  widget: Pick<DashboardLayoutWidget, 'supportedSizes'>,
  requested: GridSize,
  breakpoint: DashboardBreakpoint,
): GridSize {
  const columns = DASHBOARD_COLUMNS[breakpoint];
  const supported = supportedSizesForBreakpoint(
    widget.supportedSizes,
    breakpoint,
  );
  if (supported.length > 0) {
    return snapToSupportedSize(supported, requested) ?? supported[0];
  }

  return {
    w: clampInt(requested.w, Math.min(FREEFORM_MIN_WIDTH, columns), columns),
    h: clampInt(requested.h, FREEFORM_MIN_HEIGHT, DASHBOARD_MAX_HEIGHT),
  };
}

function normalizePersistedLayout(
  widgetsById: Map<string, DashboardLayoutWidget>,
  persisted: DashboardLayoutItem[],
  breakpoint: DashboardBreakpoint,
): DashboardLayoutItem[] {
  const columns = DASHBOARD_COLUMNS[breakpoint];
  const seen = new Set<string>();
  const candidates: DashboardLayoutItem[] = [];

  for (const item of persisted) {
    const widget = widgetsById.get(item.id);
    if (!widget || seen.has(item.id)) continue;
    seen.add(item.id);
    const size = fitWidgetSize(widget, item, breakpoint);
    candidates.push({
      id: item.id,
      x: clampInt(item.x, 0, Math.max(0, columns - size.w)),
      y: clampInt(item.y, 0, DASHBOARD_MAX_Y),
      ...size,
    });
  }

  candidates.sort(compareLayoutItems);
  const placed: DashboardLayoutItem[] = [];
  for (const item of candidates) {
    placed.push(placeWithoutCollision(item, placed, columns));
  }
  return placed;
}

function projectItem(
  widget: DashboardLayoutWidget,
  source: DashboardLayoutItem | undefined,
  sourceColumns: number,
  breakpoint: DashboardBreakpoint,
): DashboardLayoutItem {
  const columns = DASHBOARD_COLUMNS[breakpoint];
  const sourceSize = source ?? widget.defaultSize;
  const requested = {
    // A grid unit stays roughly 100px across the preview widths, so preserve
    // the unit span and only clamp when the narrower grid cannot contain it.
    w: sourceSize.w,
    h: sourceSize.h,
  };
  const size = fitWidgetSize(widget, requested, breakpoint);

  return {
    id: widget.id,
    x: source
      ? clampInt(
          Math.round((source.x * columns) / sourceColumns),
          0,
          Math.max(0, columns - size.w),
        )
      : 0,
    y: source?.y ?? 0,
    ...size,
  };
}

function materializeBreakpoint(
  widgets: DashboardLayoutWidget[],
  persisted: DashboardLayoutItem[],
  sourceLayout: DashboardLayoutItem[],
  sourceColumns: number,
  breakpoint: DashboardBreakpoint,
): DashboardLayoutItem[] {
  const widgetsById = new Map(widgets.map((widget) => [widget.id, widget]));
  const sourceById = new Map(sourceLayout.map((item) => [item.id, item]));
  const placed = normalizePersistedLayout(widgetsById, persisted, breakpoint);
  const placedIds = new Set(placed.map((item) => item.id));
  const missing = widgets
    .filter((widget) => !placedIds.has(widget.id))
    .sort((left, right) => {
      const leftSource = sourceById.get(left.id);
      const rightSource = sourceById.get(right.id);
      if (leftSource && rightSource) {
        return (
          compareLayoutItems(leftSource, rightSource) ||
          left.sortOrder - right.sortOrder
        );
      }
      if (leftSource) return -1;
      if (rightSource) return 1;
      return (
        left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)
      );
    });

  for (const widget of missing) {
    const projected = projectItem(
      widget,
      sourceById.get(widget.id),
      sourceColumns,
      breakpoint,
    );
    placed.push(
      placeWithoutCollision(projected, placed, DASHBOARD_COLUMNS[breakpoint]),
    );
  }

  return placed.sort(compareLayoutItems);
}

export function deriveDashboardLayouts(
  widgets: DashboardLayoutWidget[],
  persisted: PersistedDashboardLayouts,
): DashboardLayouts {
  const result = {} as DashboardLayouts;
  let sourceLayout: DashboardLayoutItem[] = [];
  let sourceColumns = DASHBOARD_COLUMNS.desktop;

  for (const breakpoint of DASHBOARD_BREAKPOINT_ORDER) {
    const layout = materializeBreakpoint(
      widgets,
      persisted[breakpoint] ?? [],
      sourceLayout,
      sourceColumns,
      breakpoint,
    );
    result[breakpoint] = layout;
    sourceLayout = layout;
    sourceColumns = DASHBOARD_COLUMNS[breakpoint];
  }

  return result;
}
