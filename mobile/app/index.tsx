import { FormButton } from '../src/ui/form-button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FieldGroup, Host, ListItem, Text as FormText } from '@expo/ui';
import SegmentedControl from '@expo/ui/community/segmented-control';
import { refreshable } from '@expo/ui/swift-ui/modifiers';
import type { AppSummary, SessionSummary } from '../src/core';
import { useSession } from '../src/state/session';
import { useLifetimeSignal } from '../src/state/use-lifetime-signal';
import { Action, Busy, Notice, errorText, styles } from '../src/ui/primitives';

export default function HomeScreen() {
  const { api, origin } = useSession();
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
      <View style={{ padding: 16 }}>
        <SegmentedControl
          values={['Your apps', 'Conversations']}
          selectedIndex={tab === 'apps' ? 0 : 1}
          onChange={({ nativeEvent }) =>
            setTab(nativeEvent.selectedSegmentIndex === 0 ? 'apps' : 'chats')
          }
        />
      </View>
      <Host style={styles.screen} ignoreSafeArea="all">
        <FieldGroup
          modifiers={[
            refreshable(async () => {
              await (tab === 'apps' ? apps.refetch() : sessions.refetch());
            }),
          ]}
        >
          <FieldGroup.Section title={origin?.replace(/^https?:\/\//, '')}>
            <FormButton
              label={create.isPending ? 'Creating…' : 'Start a conversation'}

              unavailable={create.isPending}
              onPress={() => create.mutate()}
            />
            {create.error ? (
              <FormText>{errorText(create.error)}</FormText>
            ) : null}
          </FieldGroup.Section>
          <FieldGroup.Section
            title={tab === 'apps' ? 'Your apps' : 'Conversations'}
          >
            {rows.map((item: AppSummary | SessionSummary) => (
              <ListItem
                key={item.id}
                onPress={() =>
                  router.push({
                    pathname: tab === 'apps' ? '/apps/[id]' : '/chat/[id]',
                    params: { id: item.id },
                  })
                }
                supportingText={
                  'description' in item
                    ? item.description || item.status
                    : `${item.messageCount} messages · ${new Date(item.updatedAt).toLocaleDateString()}`
                }
              >
                {'name' in item ? item.name : item.title}
              </ListItem>
            ))}
            {!rows.length && !loading && !failure ? (
              <FormText>
                {tab === 'apps'
                  ? 'Ask your Agent to build something. Your apps will appear here.'
                  : 'Start a conversation, attach a photo or file, and keep building from your phone.'}
              </FormText>
            ) : null}
          </FieldGroup.Section>
        </FieldGroup>
      </Host>
      {loading ? <Busy /> : null}
      {failure ? (
        <Notice
          title="Couldn’t load your Hatch"
          detail={errorText(failure)}
          action={{ label: 'Try again', onPress: refresh }}
        />
      ) : null}
    </SafeAreaView>
  );
}
