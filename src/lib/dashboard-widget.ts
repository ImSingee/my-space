export type DashboardWidgetIdentity = {
  appId: string;
  widgetId: string;
};

/** Stable identity for the one placement allowed per app widget. */
export function dashboardWidgetKey(widget: DashboardWidgetIdentity): string {
  return JSON.stringify([widget.appId, widget.widgetId]);
}

/** Never delete a placement that the submitted draft resolved as retained. */
export function dashboardWidgetIdsToRemove(
  requestedIds: string[],
  retainedIds: Iterable<string>,
): string[] {
  const retained = new Set(retainedIds);
  return requestedIds.filter((id) => !retained.has(id));
}
