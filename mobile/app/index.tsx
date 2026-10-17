import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import SegmentedControl from '@expo/ui/community/segmented-control';
import type { AppSummary, SessionSummary } from '../src/core';
import { useSession } from '../src/state/session';
import { useLifetimeSignal } from '../src/state/use-lifetime-signal';
import {
  Action,
  Brand,
  Busy,
  Notice,
  PageHeading,
  Text,
  errorText,
  styles,
  usePalette,
} from '../src/ui/primitives';
import { ResourceRow } from '../src/ui/resource-row';

export default function HomeScreen() {
  const { api, origin } = useSession();
  const c = usePalette();
  const queryClient = useQueryClient();
  const lifetimeSignal = useLifetimeSignal();
  const [tab, setTab] = useState<'apps' | 'chats'>('apps');
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
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
      api!.createSession(config.data?.defaultModel ?? {}, lifetimeSignal()),
    onSuccess: (result) => {
      if (!lifetimeSignal().aborted) {
        void queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
        router.push({ pathname: '/chat/[id]', params: { id: result.id } });
      }
    },
  });
  const rows = tab === 'apps' ? (apps.data ?? []) : (sessions.data ?? []);
  const loading = tab === 'apps' ? apps.isPending : sessions.isPending;
  const failure = tab === 'apps' ? apps.error : sessions.error;
  const refresh = () => {
    void (tab === 'apps' ? apps.refetch() : sessions.refetch());
  };
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Stack.Screen
        options={{
          headerTransparent: false,
          headerRight: () => (
            <Action
              compact
              secondary
              label="Instance"
              onPress={() => router.push('/settings')}
            />
          ),
        }}
      />
      <FlatList<AppSummary | SessionSummary>
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={
              tab === 'apps' ? apps.isRefetching : sessions.isRefetching
            }
            onRefresh={refresh}
            tintColor={c.accentText}
            colors={[c.accentText]}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 20, paddingBottom: 20 }}>
            <Brand />
            <PageHeading
              title={tab === 'apps' ? 'Your workspace.' : 'Keep building.'}
              detail={
                tab === 'apps'
                  ? 'A home for the things you make.'
                  : 'Pick up an idea, wherever you are.'
              }
            />
            <Text selectable style={[styles.caption, { color: c.muted }]}>
              {origin?.replace(/^https?:\/\//, '')}
            </Text>
            <Action
              fullWidth
              label={create.isPending ? 'Creating…' : 'Start a conversation'}
              disabled={create.isPending}
              onPress={() => create.mutate()}
            />
            {create.error ? (
              <Text accessibilityRole="alert" style={{ color: c.danger }}>
                {errorText(create.error)}
              </Text>
            ) : null}
            <SegmentedControl
              appearance="light"
              values={['Your apps', 'Conversations']}
              selectedIndex={tab === 'apps' ? 0 : 1}
              onChange={({ nativeEvent }) =>
                setTab(
                  nativeEvent.selectedSegmentIndex === 0 ? 'apps' : 'chats',
                )
              }
            />
            {failure && rows.length ? (
              <Notice
                title="Couldn’t refresh your Hatch"
                detail={errorText(failure)}
                action={{ label: 'Try again', onPress: refresh }}
              />
            ) : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListEmptyComponent={
          loading ? (
            <Busy />
          ) : failure ? (
            <Notice
              title="Couldn’t load your Hatch"
              detail={errorText(failure)}
              action={{ label: 'Try again', onPress: refresh }}
            />
          ) : (
            <Notice
              title={
                tab === 'apps'
                  ? 'A little idea can become an app.'
                  : 'What would you like to make?'
              }
              detail={
                tab === 'apps'
                  ? 'Ask your Agent to build something. Your apps will appear here.'
                  : 'Start a conversation, attach a photo or file, and keep building from your phone.'
              }
            />
          )
        }
        renderItem={({ item }) => (
          <ResourceRow
            title={'name' in item ? item.name : item.title}
            detail={
              'description' in item
                ? item.description || item.status
                : `${item.messageCount} messages · ${new Date(item.updatedAt).toLocaleDateString()}`
            }
            kind={tab === 'apps' ? 'app' : 'conversation'}
            onPress={() =>
              router.push({
                pathname: tab === 'apps' ? '/apps/[id]' : '/chat/[id]',
                params: { id: item.id },
              })
            }
          />
        )}
      />
    </SafeAreaView>
  );
}
