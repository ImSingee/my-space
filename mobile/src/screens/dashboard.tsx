import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import { useSession } from '../state/session';
import { Action, Busy, Notice, errorText } from '../ui/primitives';
import { Choice } from '../ui/native-controls';
import { Screen } from '../ui/screen';
import { SecureSurface } from '../ui/secure-surface';

export function DashboardScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin, epoch } = useSession();
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
  const handoff = useQuery({
    queryKey: [origin, 'dashboard-handoff', current?.id, epoch, attempt],
    queryFn: ({ signal }) => api!.dashboardHandoff(current!.id, signal),
    enabled: Boolean(api && current),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refresh = () => {
    void workspace.refetch();
    setAttempt((v) => v + 1);
  };
  return (
    <Screen
      title="Dashboard"
      nested={nested}
      action={<Action compact secondary label="Refresh" onPress={refresh} />}
    >
      {current ? (
        <View style={{ paddingHorizontal: 24, paddingBottom: 12 }}>
          <Choice
            label="Viewing"
            value={current.id}
            options={dashboards.map((d) => ({ label: d.name, value: d.id }))}
            onChange={setSelection}
          />
        </View>
      ) : null}
      {workspace.error || handoff.error ? (
        <View style={{ padding: 24 }}>
          <Notice
            title="Couldn’t load your dashboard"
            detail={errorText(workspace.error ?? handoff.error)}
            action={{ label: 'Try again', onPress: refresh }}
          />
        </View>
      ) : handoff.data ? (
        <SecureSurface
          key={`${current?.id}-${epoch}-${attempt}`}
          origin={origin!}
          handoff={handoff.data}
          retry={refresh}
          onOpenApp={(id) =>
            router.push({ pathname: '/apps/[id]', params: { id } })
          }
        />
      ) : workspace.isPending || (current && handoff.isPending) ? (
        <Busy label="Loading your dashboard…" />
      ) : (
        <Notice
          title="No dashboards yet"
          detail="Create a dashboard in Hatch on the web to see it here."
        />
      )}
    </Screen>
  );
}
