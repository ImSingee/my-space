import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { router, useIsFocused } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dashboardDestination, type BrowserDestination } from '../core';
import { useSession } from '../state/session';
import { Busy, EmptyState, Notice, Tag, errorText } from '../ui/primitives';
import { ScopeTabs } from '../ui/scope-tabs';
import { Screen } from '../ui/screen';
import { SecureSurface } from '../ui/secure-surface';
import { palette as c, radii } from '../ui/theme';

function refreshLabel(seconds: number) {
  return seconds >= 3600
    ? `Every ${Math.round(seconds / 3600)} h`
    : seconds >= 60
      ? `Every ${Math.round(seconds / 60)} min`
      : `Every ${seconds} s`;
}

export function DashboardScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin, epoch } = useSession();
  const insets = useSafeAreaInsets();
  // Native tabs mount hidden screens. Handoff tickets live for a minute, so
  // only request one when the dashboard is actually on screen.
  const focused = useIsFocused();
  const [selection, setSelection] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const dashboards = workspace.data?.dashboards ?? [];
  const current =
    dashboards.find((d) => d.id === selection) ??
    dashboards.find((d) => d.pinned) ??
    dashboards[0];
  let destination: BrowserDestination | null = null;
  let invalid: unknown = null;
  try {
    destination = current ? dashboardDestination(current.id) : null;
  } catch (error) {
    invalid = error;
  }
  // One sign-in per surface: switching dashboards navigates the same WebView.
  const handoff = useQuery({
    queryKey: [origin, 'browser-handoff', 'dashboard', epoch, attempt],
    queryFn: ({ signal }) => api!.createHandoff(signal),
    enabled: Boolean(api && destination && focused),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // The canvas owns widget refresh; this re-reads the list and signs in anew.
  const retry = () => {
    void workspace.refetch();
    setAttempt((v) => v + 1);
  };
  // Dated by the last workspace refresh, so the masthead says when it was read.
  const today = workspace.dataUpdatedAt
    ? new Date(workspace.dataUpdatedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : 'Today';
  return (
    <Screen eyebrow={today} title="Dashboard" nested={nested}>
      {dashboards.length ? (
        <ScopeTabs
          label="Dashboards"
          value={current?.id ?? ''}
          options={dashboards.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setSelection}
        />
      ) : null}
      {current && (current.pinned || current.autoRefreshSeconds) ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 6,
            paddingHorizontal: 20,
            paddingTop: 6,
            paddingBottom: 12,
          }}
        >
          {current.pinned ? (
            <Tag tone="lime" glyph="pin" label="Pinned" />
          ) : null}
          {current.autoRefreshSeconds ? (
            <Tag
              tone="outline"
              glyph="refresh"
              label={refreshLabel(current.autoRefreshSeconds)}
            />
          ) : null}
        </View>
      ) : null}
      <View
        style={{
          flex: 1,
          marginHorizontal: 10,
          marginBottom: insets.bottom + 6,
          borderRadius: radii.sheet,
          backgroundColor: c.card,
          overflow: 'hidden',
        }}
      >
        {(workspace.error && !workspace.data) || handoff.error || invalid ? (
          <View style={{ padding: 12 }}>
            <Notice
              tone="danger"
              title="Couldn’t load your dashboard"
              detail={errorText(workspace.error ?? handoff.error ?? invalid)}
              action={{ label: 'Try again', onPress: retry }}
            />
          </View>
        ) : handoff.data && destination ? (
          <SecureSurface
            key={`${epoch}-${attempt}`}
            origin={origin!}
            handoff={handoff.data}
            destination={destination}
            retry={retry}
            onOpenApp={(slug) =>
              router.push({
                pathname: '/apps/[id]',
                params: { id: slug, slug },
              })
            }
          />
        ) : workspace.isPending || (current && handoff.isPending) ? (
          <Busy label="Loading widgets" />
        ) : (
          <View style={{ paddingHorizontal: 20 }}>
            <EmptyState
              title="No dashboards yet"
              detail="Create a dashboard in Hatch on the web. Its widgets will appear here, live."
            />
          </View>
        )}
      </View>
    </Screen>
  );
}
