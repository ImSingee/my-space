export const tabIds = ['dashboard', 'apps', 'agent', 'workflows'] as const;
export type TabId = (typeof tabIds)[number];
export type NavigationPreferences = {
  order: TabId[];
  visible: TabId[];
  defaultTab: TabId | 'more';
};
export const defaultNavigation: NavigationPreferences = {
  order: [...tabIds],
  visible: ['dashboard', 'apps', 'agent'],
  defaultTab: 'dashboard',
};
export function normalizeNavigation(value: unknown): NavigationPreferences {
  if (!value || typeof value !== 'object') return { ...defaultNavigation };
  const input = value as Partial<NavigationPreferences>;
  const isTab = (id: unknown): id is TabId => tabIds.includes(id as TabId);
  const order = Array.isArray(input.order)
    ? [...new Set(input.order.filter(isTab))]
    : [];
  for (const id of tabIds) if (!order.includes(id)) order.push(id);
  const visible = Array.isArray(input.visible)
    ? [...new Set(input.visible.filter(isTab))]
    : [...defaultNavigation.visible];
  const defaultTab =
    input.defaultTab === 'more' ||
    (isTab(input.defaultTab) && visible.includes(input.defaultTab))
      ? input.defaultTab
      : (order.find((id) => visible.includes(id)) ?? 'more');
  return { order, visible, defaultTab };
}
