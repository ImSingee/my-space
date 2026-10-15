import { useMutation, useQuery } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import type { AppSummary, SessionSummary } from '../src/core';
import { useSession } from '../src/state/session';
import { useLifetimeSignal } from '../src/state/use-lifetime-signal';
import {
  Action,
  Busy,
  Notice,
  Text,
  errorText,
  styles,
  usePalette,
} from '../src/ui/primitives';

export default function HomeScreen() {
  const { api, origin } = useSession();
  const c = usePalette();
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
      if (!lifetimeSignal().aborted)
        router.push({ pathname: '/chat/[id]', params: { id: result.id } });
    },
  });
  const rows = tab === 'apps' ? (apps.data ?? []) : (sessions.data ?? []);
  const loading = tab === 'apps' ? apps.isPending : sessions.isPending;
  const failure = tab === 'apps' ? apps.error : sessions.error;
  const refreshing = tab === 'apps' ? apps.isRefetching : sessions.isRefetching;
  const refresh = () => {
    void (tab === 'apps' ? apps.refetch() : sessions.refetch());
  };
  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Instance settings"
              onPress={() => router.push('/settings')}
              hitSlop={10}
            >
              <Text
                maxFontSizeMultiplier={1.4}
                style={{ color: c.accent, fontSize: 16 }}
              >
                Instance
              </Text>
            </Pressable>
          ),
        }}
      />
      <FlatList<AppSummary | SessionSummary>
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.content, { flexGrow: 1 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={c.accent}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 18 }}>
            <Text
              style={[styles.caption, { color: c.muted }]}
              numberOfLines={1}
            >
              {origin?.replace(/^https?:\/\//, '')}
            </Text>
            <View
              style={[
                styles.row,
                { backgroundColor: c.border, padding: 4, borderRadius: 13 },
              ]}
            >
              {(['apps', 'chats'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: value === tab }}
                  onPress={() => setTab(value)}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    padding: 11,
                    borderRadius: 10,
                    backgroundColor: value === tab ? c.card : 'transparent',
                  }}
                >
                  <Text style={{ color: c.text, fontWeight: '600' }}>
                    {value === 'apps' ? 'Your apps' : 'Conversations'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Action
              label={create.isPending ? 'Creating…' : 'Start a conversation'}
              disabled={create.isPending}
              onPress={() => create.mutate()}
            />
            {create.error ? (
              <Text accessibilityRole="alert" style={{ color: c.danger }}>
                {errorText(create.error)}
              </Text>
            ) : null}
            {failure && rows.length > 0 ? (
              <Notice
                title="Couldn’t refresh your Hatch"
                detail={errorText(failure)}
                action={{ label: 'Try again', onPress: refresh }}
              />
            ) : null}
          </View>
        }
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
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: tab === 'apps' ? '/apps/[id]' : '/chat/[id]',
                params: { id: item.id },
              })
            }
            style={({ pressed }) => [
              {
                backgroundColor: c.card,
                borderRadius: 20,
                padding: 19,
                gap: 8,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <View style={styles.row}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 13,
                  backgroundColor: c.subtle,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={{ fontSize: 22, fontWeight: '600', color: c.accent }}
                >
                  {'name' in item ? item.name.charAt(0).toUpperCase() : '↗'}
                </Text>
              </View>
              <Text
                numberOfLines={2}
                style={{
                  flex: 1,
                  color: c.text,
                  fontSize: 18,
                  fontWeight: '600',
                }}
              >
                {'name' in item ? item.name : item.title}
              </Text>
              <Text
                allowFontScaling={false}
                style={{ color: c.muted, fontSize: 22 }}
              >
                ›
              </Text>
            </View>
            <Text
              style={[styles.caption, { color: c.muted }]}
              numberOfLines={2}
            >
              {'description' in item
                ? item.description || item.status
                : `${item.messageCount} messages · ${new Date(item.updatedAt).toLocaleDateString()}`}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}
