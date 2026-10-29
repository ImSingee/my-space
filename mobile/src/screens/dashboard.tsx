import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REFRESH_PRESETS, formatInterval } from '@hatch/platform-api';
import { useCallback, useEffect, useState } from 'react';
import { router, useIsFocused } from 'expo-router';
import { Animated, Easing, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dashboardDestination, type BrowserDestination } from '../core';
import { useSession } from '../state/session';
import { useAppActive } from '../state/use-app-active';
import { useDashboardAutoRefresh } from '../state/use-dashboard-auto-refresh';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { IconButton } from '../ui/button';
import { Choice } from '../ui/native-controls';
import {
  Busy,
  EmptyState,
  Notice,
  Tag,
  errorText,
  useReducedMotion,
} from '../ui/primitives';
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
        <RefreshButton
          revision={refreshRevision}
          onPress={refresh}
          disabled={!ready}
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
      {current ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {current.pinned ? (
              <Tag tone="lime" glyph="pin" label="Pinned" />
            ) : null}
            <Choice
              label="Auto refresh"
              value={String(seconds)}
              glyph="refresh"
              disabled={saveInterval.isPending}
              options={intervals.map((preset) => ({
                value: String(preset.seconds),
                label: preset.seconds
                  ? 'Every ' + preset.label
                  : 'Auto refresh off',
              }))}
              onChange={(value) =>
                saveInterval.mutate({ id: current.id, seconds: Number(value) })
              }
            />
          </View>
          {saveInterval.error ? (
            <Notice
              tone="danger"
              title="Couldn’t save refresh interval"
              detail={errorText(saveInterval.error)}
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
            dashboardRefresh={{ id: current!.id, revision: refreshRevision }}
            onReady={setReady}
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

/** Turns once per refresh, so a tap or a timed refresh is visible. */
function RefreshButton({
  revision,
  onPress,
  disabled,
}: {
  revision: number;
  onPress: () => void;
  disabled: boolean;
}) {
  const reduced = useReducedMotion();
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!revision || reduced) return;
    turn.setValue(0);
    const spin = Animated.timing(turn, {
      toValue: 1,
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    spin.start();
    return () => spin.stop();
  }, [revision, reduced, turn]);
  return (
    <Animated.View
      style={{
        transform: [
          {
            rotate: turn.interpolate({
              inputRange: [0, 1],
              outputRange: ['0deg', '360deg'],
            }),
          },
        ],
      }}
    >
      <IconButton
        label="Refresh dashboard"
        glyph="refresh"
        onPress={onPress}
        disabled={disabled}
      />
    </Animated.View>
  );
}
