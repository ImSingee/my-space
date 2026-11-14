import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REFRESH_PRESETS, formatInterval } from '@hatch/platform-api';
import { useCallback, useState } from 'react';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dashboardDestination, type BrowserDestination } from '../core';
import { useSession } from '../state/session';
import { openSurfaceLink } from '../state/deep-links';
import { useAppActive } from '../state/use-app-active';
import { useDashboardAutoRefresh } from '../state/use-dashboard-auto-refresh';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { useSurfaceHandoff } from '../state/use-surface-handoff';
import { RefreshMenu } from '../ui/native-controls';
import { Busy, EmptyState, Notice, errorText } from '../ui/primitives';
import { ScopeTabs } from '../ui/scope-tabs';
import { Screen } from '../ui/screen';
import { SecureSurface } from '../ui/secure-surface';
import { palette as c, radii } from '../ui/theme';

export function DashboardScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin, epoch } = useSession();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const lifetime = useLifetimeSignal();
  const [ready, setReady] = useState(false);
  // Each bump asks the loaded canvas to refresh its widgets once.
  const [refreshRevision, setRefreshRevision] = useState(0);
  // Native tabs mount hidden screens: the surface's sign-in and the refresh
  // timer wait until this one is on screen.
  const focused = useIsFocused();
  // A link names a dashboard; each delivery (a new `at`) selects it again.
  const linked = useLocalSearchParams<{ dashboard?: string; at?: string }>();
  const delivery = linked.dashboard ? `${linked.dashboard} ${linked.at}` : null;
  const [selection, setSelection] = useState(linked.dashboard ?? null);
  const [delivered, setDelivered] = useState(delivery);
  if (delivery !== delivered) {
    setDelivered(delivery);
    if (linked.dashboard) setSelection(linked.dashboard);
  }
  const [attempt, setAttempt] = useState(0);
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const dashboards = workspace.data?.dashboards ?? [];
  const missing =
    Boolean(workspace.data && selection) &&
    selection === linked.dashboard &&
    !dashboards.some((d) => d.id === selection);
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
  // Recovery re-reads the list and establishes a fresh browser session.
  const retry = () => {
    void workspace.refetch();
    setAttempt((v) => v + 1);
  };
  const refreshWidgets = useCallback(
    () => setRefreshRevision((value) => value + 1),
    [],
  );
  // A manual refresh also re-reads names and intervals saved on the web.
  const refresh = () => {
    void workspace.refetch();
    refreshWidgets();
  };
  const seconds = current?.autoRefreshSeconds ?? 0;
  const active = useAppActive();
  useDashboardAutoRefresh({
    enabled: focused && active && ready,
    dashboardId: current?.id,
    seconds,
    refresh: refreshWidgets,
  });
  const saveInterval = useMutation({
    mutationFn: (input: { id: string; seconds: number }) =>
      api!.setDashboardAutoRefresh(input.id, input.seconds, lifetime()),
    onSuccess: (result, input) => {
      if (lifetime().aborted) return;
      queryClient.setQueryData<typeof workspace.data>(
        [origin, 'workspace'],
        (data) =>
          data
            ? {
                ...data,
                dashboards: data.dashboards.map((dashboard) =>
                  dashboard.id === input.id
                    ? { ...dashboard, autoRefreshSeconds: result.seconds }
                    : dashboard,
                ),
              }
            : data,
      );
    },
  });
  const intervals = REFRESH_PRESETS.some((preset) => preset.seconds === seconds)
    ? REFRESH_PRESETS
    : [...REFRESH_PRESETS, { label: formatInterval(seconds), seconds }];
  // Dated by the last workspace refresh, so the masthead says when it was read.
  const today = workspace.dataUpdatedAt
    ? new Date(workspace.dataUpdatedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : 'Today';
  return (
    <Screen
      eyebrow={today}
      title="Dashboard"
      nested={nested}
      actions={
        <RefreshMenu
          label="Refresh dashboard"
          // With no dashboards there is no canvas to wait for; a refresh
          // can still find one created on the web.
          disabled={!ready && !(workspace.data && !dashboards.length)}
          onRefresh={refresh}
          interval={String(current ? seconds : 0)}
          intervalLabel={seconds ? formatInterval(seconds) : undefined}
          intervalDisabled={!current || saveInterval.isPending}
          options={intervals.map((preset) => ({
            value: String(preset.seconds),
            label: preset.seconds ? 'Every ' + preset.label : 'Off',
          }))}
          onInterval={(value) => {
            if (current)
              saveInterval.mutate({ id: current.id, seconds: Number(value) });
          }}
        />
      }
    >
      {dashboards.length ? (
        <ScopeTabs
          label="Dashboards"
          value={current?.id ?? ''}
          options={dashboards.map((d) => ({ value: d.id, label: d.name }))}
          onChange={setSelection}
        />
      ) : null}
      {missing ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Notice
            tone="danger"
            title="Couldn’t find that dashboard"
            detail="It may have been deleted. Showing another dashboard."
          />
        </View>
      ) : null}
      {saveInterval.error ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <Notice
            tone="danger"
            title="Couldn’t save refresh interval"
            detail={errorText(saveInterval.error)}
          />
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
        {(workspace.error && !workspace.data) || invalid ? (
          <View style={{ padding: 12 }}>
            <Notice
              tone="danger"
              title="Couldn’t load your dashboard"
              detail={errorText(workspace.error ?? invalid)}
              action={{ label: 'Try again', onPress: retry }}
            />
          </View>
        ) : destination && current ? (
          // One surface per lifetime: switching dashboards navigates the same
          // WebView, and a surface that comes back signs in afresh.
          <DashboardSurface
            key={`${epoch}-${attempt}`}
            origin={origin!}
            focused={focused}
            destination={destination}
            dashboardRefresh={{ id: current.id, revision: refreshRevision }}
            retry={retry}
            onReady={setReady}
          />
        ) : workspace.isPending ? (
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

/** Owns one web surface and the one-use ticket it signs in with. */
function DashboardSurface({
  origin,
  focused,
  destination,
  dashboardRefresh,
  retry,
  onReady,
}: {
  origin: string;
  focused: boolean;
  destination: BrowserDestination;
  dashboardRefresh: { id: string; revision: number };
  retry: () => void;
  onReady: (ready: boolean) => void;
}) {
  const { api } = useSession();
  // Native tabs mount hidden screens. Tickets live for a minute, so a hidden
  // dashboard waits until it is on screen before claiming one.
  const handoff = useSurfaceHandoff({ api, origin, focused });
  if (handoff.error)
    return (
      <View style={{ padding: 12 }}>
        <Notice
          tone="danger"
          title="Couldn’t load your dashboard"
          detail={errorText(handoff.error)}
          action={{ label: 'Try again', onPress: retry }}
        />
      </View>
    );
  if (!handoff.data) return <Busy label="Loading widgets" />;
  return (
    <SecureSurface
      origin={origin}
      handoff={handoff.data}
      destination={destination}
      retry={retry}
      dashboardRefresh={dashboardRefresh}
      onReady={onReady}
      onRoute={openSurfaceLink}
    />
  );
}
