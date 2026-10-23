import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { FlatList, RefreshControl, View } from 'react-native';
import { useSession } from '../state/session';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { Action, Busy, Notice, errorText, usePalette } from '../ui/primitives';
import { ResourceRow } from '../ui/resource-row';
import { Screen } from '../ui/screen';
export function AgentScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  const signal = useLifetimeSignal();
  const c = usePalette();
  const sessions = useQuery({
    queryKey: [origin, 'sessions'],
    queryFn: ({ signal }) => api!.sessions(undefined, signal),
    enabled: Boolean(api),
  });
  const config = useQuery({
    queryKey: [origin, 'config'],
    queryFn: ({ signal }) => api!.config(signal),
    enabled: Boolean(api),
  });
  const create = useMutation({
    mutationFn: () =>
      api!.createSession(config.data?.defaultModel ?? {}, signal()),
    onSuccess: (result) => {
      if (signal().aborted) return;
      void queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
      router.push({ pathname: '/chat/[id]', params: { id: result.id } });
    },
  });
  return (
    <Screen
      title="Agent"
      subtitle="Pick up where your ideas left off."
      nested={nested}
      action={
        <Action
          label={create.isPending ? 'Creating…' : 'New chat'}
          compact
          secondary
          disabled={create.isPending}
          onPress={() => create.mutate()}
        />
      }
    >
      <FlatList
        data={sessions.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={sessions.isRefetching}
            onRefresh={() => void sessions.refetch()}
            tintColor={c.accentText}
          />
        }
        ListHeaderComponent={
          create.error ? (
            <Notice
              title="Couldn’t create a conversation"
              detail={errorText(create.error)}
            />
          ) : undefined
        }
        ListEmptyComponent={
          sessions.isPending ? (
            <Busy />
          ) : sessions.error ? (
            <Notice
              title="Couldn’t load conversations"
              detail={errorText(sessions.error)}
              action={{
                label: 'Try again',
                onPress: () => void sessions.refetch(),
              }}
            />
          ) : (
            <View style={{ paddingTop: 48 }}>
              <Notice
                title="What would you like to make?"
                detail="Build a small tool, explore an idea, or improve an app. Your conversations stay with your workspace."
                action={{
                  label: 'Start a conversation',
                  onPress: () => {
                    if (!create.isPending) create.mutate();
                  },
                }}
              />
            </View>
          )
        }
        renderItem={({ item }) => (
          <ResourceRow
            title={item.title || 'New conversation'}
            detail={`${item.messageCount} messages · ${new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
            kind="conversation"
            onPress={() =>
              router.push({ pathname: '/chat/[id]', params: { id: item.id } })
            }
          />
        )}
      />
    </Screen>
  );
}
