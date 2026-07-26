import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { dashboardQueryOptions } from '~queries/dashboards';
import {
  type AvailableWidget,
  type DashboardData,
  type DashboardItem,
  saveDashboardDraft,
} from '~server/dashboards';
import {
  DASHBOARD_BREAKPOINT_ORDER,
  deriveDashboardLayouts,
  fitWidgetSize,
  type DashboardBreakpoint,
  type DashboardLayoutItem,
} from '~/lib/dashboard-layout';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';

export type DashboardDraftStatus =
  | { state: 'editing' }
  | { state: 'saving' }
  | { state: 'checking' }
  | { state: 'error'; message: string }
  | { state: 'conflict'; message: string }
  | { state: 'unknown'; message: string };

type SaveMismatchStatus = Extract<
  DashboardDraftStatus,
  { state: 'conflict' | 'error' | 'unknown' }
>;

const UNKNOWN_SAVE_STATUS: SaveMismatchStatus = {
  state: 'unknown',
  message:
    'Save status is still being confirmed. Check again before leaving this page.',
};

function cloneDashboardData(data: DashboardData): DashboardData {
  return {
    revision: data.revision,
    widgets: data.widgets.map((widget) => ({
      ...widget,
      defaultSize: { ...widget.defaultSize },
      supportedSizes: widget.supportedSizes.map((size) => ({ ...size })),
    })),
    layouts: {
      desktop: data.layouts.desktop.map((item) => ({ ...item })),
      tablet: data.layouts.tablet.map((item) => ({ ...item })),
      mobile: data.layouts.mobile.map((item) => ({ ...item })),
    },
  };
}

function canonicalDraft(data: DashboardData): string | null {
  const identities = new Map(
    data.widgets.map((widget) => [widget.id, dashboardWidgetKey(widget)]),
  );
  if (new Set(identities.values()).size !== data.widgets.length) return null;

  const layoutEntries = DASHBOARD_BREAKPOINT_ORDER.map((breakpoint) => {
    const items: Array<{
      identity: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    for (const item of data.layouts[breakpoint]) {
      const identity = identities.get(item.id);
      if (!identity) return [breakpoint, null] as const;
      items.push({
        identity,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      });
    }
    items.sort((left, right) => left.identity.localeCompare(right.identity));
    return [breakpoint, items] as const;
  });
  const layouts = Object.fromEntries(layoutEntries);
  if (Object.values(layouts).some((layout) => layout === null)) return null;

  return JSON.stringify({
    widgets: [...identities.values()].sort(),
    layouts,
  });
}

/** Compare drafts by app/widget identity so server-assigned placement ids do not matter. */
export function dashboardDraftsEqual(
  left: DashboardData,
  right: DashboardData,
): boolean {
  const leftCanonical = canonicalDraft(left);
  return leftCanonical !== null && leftCanonical === canonicalDraft(right);
}

export function useDashboardDraft({
  dashboardId,
  initialData,
}: {
  dashboardId: string;
  initialData: DashboardData;
}) {
  const queryClient = useQueryClient();
  const [baseline, setBaseline] = useState(() =>
    cloneDashboardData(initialData),
  );
  const [draft, setDraft] = useState(() => cloneDashboardData(initialData));
  const [status, setStatus] = useState<DashboardDraftStatus>({
    state: 'editing',
  });

  const cancelDisabled =
    status.state === 'saving' ||
    status.state === 'checking' ||
    status.state === 'unknown';
  const locked = cancelDisabled || status.state === 'conflict';
  const dirty = useMemo(
    () => !dashboardDraftsEqual(baseline, draft),
    [baseline, draft],
  );

  const reset = useCallback((data: DashboardData) => {
    const next = cloneDashboardData(data);
    setBaseline(next);
    setDraft(cloneDashboardData(next));
    setStatus({ state: 'editing' });
  }, []);

  const markEdited = useCallback(() => {
    setStatus((current) =>
      current.state === 'error' ? { state: 'editing' } : current,
    );
  }, []);

  const commitLayout = useCallback(
    (breakpoint: DashboardBreakpoint, layout: DashboardLayoutItem[]) => {
      if (locked) return;
      setDraft((current) => ({
        ...current,
        layouts: {
          ...current.layouts,
          [breakpoint]: layout.map((item) => ({ ...item })),
        },
      }));
      markEdited();
    },
    [locked, markEdited],
  );

  const addWidget = useCallback(
    (widget: AvailableWidget) => {
      if (locked) return;
      const id = `draft:${crypto.randomUUID()}`;
      setDraft((current) => {
        const nextWidget: DashboardItem = {
          id,
          appId: widget.appId,
          appSlug: widget.appSlug,
          appName: widget.appName,
          widgetId: widget.widgetId,
          name: widget.name,
          url: widget.url,
          sortOrder:
            Math.max(-1, ...current.widgets.map((item) => item.sortOrder)) + 1,
          defaultSize: widget.defaultSize,
          supportedSizes: widget.supportedSizes,
        };
        const size = fitWidgetSize(
          nextWidget,
          nextWidget.defaultSize,
          'desktop',
        );
        const bottom = current.layouts.desktop.reduce(
          (value, item) => Math.max(value, item.y + item.h),
          0,
        );
        const widgets = [...current.widgets, nextWidget];
        const layouts = deriveDashboardLayouts(widgets, {
          desktop: [
            ...current.layouts.desktop,
            { id, x: 0, y: bottom, ...size },
          ],
          tablet: current.layouts.tablet,
          mobile: current.layouts.mobile,
        });
        return { ...current, widgets, layouts };
      });
      markEdited();
    },
    [locked, markEdited],
  );

  const removeWidget = useCallback(
    (id: string) => {
      if (locked) return;
      setDraft((current) => ({
        ...current,
        widgets: current.widgets.filter((widget) => widget.id !== id),
        layouts: {
          desktop: current.layouts.desktop.filter((item) => item.id !== id),
          tablet: current.layouts.tablet.filter((item) => item.id !== id),
          mobile: current.layouts.mobile.filter((item) => item.id !== id),
        },
      }));
      markEdited();
    },
    [locked, markEdited],
  );

  const fetchAuthoritative = useCallback(async () => {
    const options = dashboardQueryOptions(dashboardId);
    await queryClient.invalidateQueries({
      queryKey: options.queryKey,
      refetchType: 'none',
    });
    return queryClient.fetchQuery(options);
  }, [dashboardId, queryClient]);

  const reconcileUnknownSave = useCallback(
    async (
      submitted: DashboardData,
      mismatchStatus: SaveMismatchStatus,
    ): Promise<boolean> => {
      try {
        const authoritative = await fetchAuthoritative();
        if (dashboardDraftsEqual(authoritative, submitted)) {
          setBaseline(cloneDashboardData(authoritative));
          setDraft(cloneDashboardData(authoritative));
          setStatus({ state: 'editing' });
          return true;
        }
        // A first mismatching read can still be older than a request whose
        // response was lost before the server acquired its dashboard lock. Do
        // not replace the confirmed baseline or unlock Cancel in that window.
        if (mismatchStatus.state !== 'unknown') {
          setBaseline(cloneDashboardData(authoritative));
        }
        setStatus(mismatchStatus);
        return false;
      } catch {
        setStatus(UNKNOWN_SAVE_STATUS);
        return false;
      }
    },
    [fetchAuthoritative],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (locked) return false;
    if (!dirty) return true;
    const submitted = cloneDashboardData(draft);
    const submittedWidgetKeys = new Set(
      submitted.widgets.map(dashboardWidgetKey),
    );
    const removedWidgetIds = baseline.widgets
      .filter((widget) => !submittedWidgetKeys.has(dashboardWidgetKey(widget)))
      .map((widget) => widget.id);
    setStatus({ state: 'saving' });

    try {
      const result = await saveDashboardDraft({
        data: {
          dashboardId,
          expectedRevision: submitted.revision,
          removedWidgetIds,
          widgets: submitted.widgets.map((widget) => ({
            id: widget.id,
            appId: widget.appId,
            widgetId: widget.widgetId,
          })),
          layouts: submitted.layouts,
        },
      });
      if (result.status === 'conflict') {
        return reconcileUnknownSave(submitted, {
          state: 'conflict',
          message:
            'Dashboard changed in another tab. Cancel this edit and reopen it before making more changes.',
        });
      }
      const saved = result.data;
      queryClient.setQueryData(
        dashboardQueryOptions(dashboardId).queryKey,
        saved,
      );
      setBaseline(cloneDashboardData(saved));
      setDraft(cloneDashboardData(saved));
      setStatus({ state: 'editing' });
      return true;
    } catch {
      return reconcileUnknownSave(submitted, UNKNOWN_SAVE_STATUS);
    }
  }, [
    baseline.widgets,
    dashboardId,
    dirty,
    draft,
    locked,
    queryClient,
    reconcileUnknownSave,
  ]);

  const checkStatus = useCallback(async (): Promise<boolean> => {
    if (status.state !== 'unknown') return false;
    const submitted = cloneDashboardData(draft);
    setStatus({ state: 'checking' });
    return reconcileUnknownSave(submitted, {
      state: 'error',
      message: 'Dashboard changes were not saved. Your draft is still here.',
    });
  }, [draft, reconcileUnknownSave, status.state]);

  const cancel = useCallback((): boolean => {
    if (cancelDisabled) return false;
    setDraft(cloneDashboardData(baseline));
    setStatus({ state: 'editing' });
    return true;
  }, [baseline, cancelDisabled]);

  return {
    draft,
    status,
    dirty,
    locked,
    cancelDisabled,
    reset,
    commitLayout,
    addWidget,
    removeWidget,
    save,
    checkStatus,
    cancel,
  };
}
