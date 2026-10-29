import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import type { SessionSummary } from '../core';
import { useSession } from '../state/session';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { Glyph } from '../ui/glyph';
import { Busy, EmptyState, Notice, Tag, errorText } from '../ui/primitives';
import {
  Masthead,
  PageRoot,
  SectionLabel,
  pageScrollProps,
} from '../ui/screen';
import { Text, type } from '../ui/text';
import { palette as c, radii } from '../ui/theme';

const day = 24 * 60 * 60 * 1000;

function sectionsOf(sessions: SessionSummary[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const buckets = [
    { title: 'Today', from: today },
    { title: 'Yesterday', from: today - day },
    { title: 'This week', from: today - 6 * day },
    { title: 'Earlier', from: -Infinity },
  ];
  return buckets
    .map((bucket, index) => ({
      title: bucket.title,
      data: sessions.filter((item) => {
        const at = new Date(item.updatedAt).getTime();
        const until = index ? buckets[index - 1].from : Infinity;
        return at >= bucket.from && at < until;
      }),
    }))
    .filter((section) => section.data.length);
}

// Section headers already name the day; rows add the detail that is missing.
function stamp(iso: string) {
  const at = new Date(iso);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const since = at.getTime() - start.getTime();
  if (since >= -day)
    return at.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  if (since >= -6 * day)
    return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function AgentScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const signal = useLifetimeSignal();
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
  const start = () => {
    if (!create.isPending) create.mutate();
  };
  const pull = usePullToRefresh(focused, () => sessions.refetch());
  const list = sessions.data ?? [];
  return (
    <PageRoot nested={nested}>
      <SectionList
        {...pageScrollProps}
        sections={sectionsOf(list)}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={c.moss}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <View style={{ marginHorizontal: -16 }}>
              <Masthead
                eyebrow={
                  sessions.data
                    ? `Agent · ${list.length} conversation${list.length === 1 ? '' : 's'}`
                    : 'Agent'
                }
                title="Agent"
                nested={nested}
              />
            </View>
            <StartCard busy={create.isPending} onPress={start} />
            {create.error ? (
              <Notice
                tone="danger"
                title="Couldn’t start a conversation"
                detail={errorText(create.error)}
              />
            ) : null}
            {sessions.error && sessions.data ? (
              <Notice
                tone="danger"
                title="Couldn’t refresh"
                detail={errorText(sessions.error)}
                action={{
                  label: 'Try again',
                  onPress: () => void sessions.refetch(),
                }}
              />
            ) : null}
          </View>
        }
        ListEmptyComponent={
          sessions.isPending ? (
            <Busy label="Finding conversations" />
          ) : sessions.error ? (
            <View style={{ paddingTop: 16 }}>
              <Notice
                tone="danger"
                title="Couldn’t load conversations"
                detail={errorText(sessions.error)}
                action={{
                  label: 'Try again',
                  onPress: () => void sessions.refetch(),
                }}
              />
            </View>
          ) : (
            <EmptyState
              title="A quiet notebook"
              detail="Your conversations with the Agent are kept on your instance. Start one above."
            />
          )
        }
        renderSectionHeader={({ section }) => (
          <SectionLabel count={section.data.length}>
            {section.title}
          </SectionLabel>
        )}
        ItemSeparatorComponent={() => (
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: c.rule,
              marginLeft: 76,
            }}
          />
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title || 'New conversation'}, ${item.messageCount} messages, updated ${stamp(item.updatedAt)}`}
            onPress={() =>
              router.push({ pathname: '/chat/[id]', params: { id: item.id } })
            }
            style={({ pressed }) => ({
              minHeight: 64,
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 12,
              paddingVertical: 14,
              paddingHorizontal: 4,
              borderRadius: 14,
              backgroundColor: pressed ? c.limeSoft : 'transparent',
            })}
          >
            <Text
              maxFontSizeMultiplier={1.4}
              numberOfLines={1}
              style={[type.meta, { minWidth: 60, paddingTop: 3 }]}
            >
              {stamp(item.updatedAt)}
            </Text>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={type.heading} numberOfLines={2}>
                {item.title || 'New conversation'}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Tag
                  tone="quiet"
                  label={`${item.messageCount} message${item.messageCount === 1 ? '' : 's'}`}
                />
                {item.appIds.length ? (
                  <Tag
                    tone="outline"
                    glyph="apps"
                    label={`${item.appIds.length} app${item.appIds.length === 1 ? '' : 's'}`}
                  />
                ) : null}
              </View>
            </View>
            <View style={{ paddingTop: 5 }}>
              <Glyph name="chevron" size={12} color={c.inkFaint} />
            </View>
          </Pressable>
        )}
      />
    </PageRoot>
  );
}

function StartCard({ busy, onPress }: { busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New conversation"
      accessibilityHint="Creates a conversation and opens it"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: c.moss,
        borderRadius: radii.sheet,
        padding: 20,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        opacity: busy ? 0.7 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={[type.meta, { color: c.lime }]}>
          {busy ? 'Starting…' : 'New conversation'}
        </Text>
        <Text style={[type.title, { color: c.onMoss }]}>
          What should we make?
        </Text>
        <Text style={[type.small, { color: c.onMoss, opacity: 0.86 }]}>
          Describe an App, a fix or a half-formed idea.
        </Text>
      </View>
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: c.lime,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Glyph name="plus" size={22} color={c.ink} />
      </View>
    </Pressable>
  );
}
