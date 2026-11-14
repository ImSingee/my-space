import { router } from 'expo-router';
import type {
  NavigationPreferences,
  TabId,
} from '../core/navigation-preferences';

/**
 * Shows a section where this phone keeps it: its tab when it is in the tab
 * bar, otherwise the Library screen pushed over the current one.
 */
export function openSection(
  id: TabId | 'more',
  preferences: NavigationPreferences,
  params: Record<string, string> = {},
) {
  if (id === 'more' || preferences.visible.includes(id))
    router.navigate({ pathname: `/(tabs)/${id}`, params });
  else router.push({ pathname: '/library', params: { kind: id, ...params } });
}
