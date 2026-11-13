import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import { useEffect, useRef } from 'react';
import { useSession } from '../state/session';
import {
  conversationSplit,
  fromConversationList,
  useAgentSelection,
} from '../state/use-agent-selection';
import { useConversationListRefresh } from '../state/use-conversation-list-refresh';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { useFoldSplit } from '../ui/columns';
import { Glyph } from '../ui/glyph';
import { Busy, EmptyState, Notice, Tag, errorText } from '../ui/primitives';
import { sectionsOf, stamp } from '../ui/session-dates';
import {
  Masthead,
  PageRoot,
  SectionLabel,
  pageScrollProps,
} from '../ui/screen';
import { Text, type } from '../ui/text';
import { palette as c, radii } from '../ui/theme';
import { Conversation } from './conversation';

export function AgentScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const focused = useIsFocused();
  const queryClient = useQueryClient();
  const signal = useLifetimeSignal();
  // With room for both, the open conversation sits beside the list, its
  // edge on the fold; otherwise it is pushed over the list.
  const { ref, onLayout, split } = useFoldSplit(conversationSplit);
  const [selected, select] = useAgentSelection();
  const open = (id: string, push = !split) => {
    select(id);
    if (push)
      router.push({
        pathname: '/chat/[id]',
        params: { id, from: fromConversationList },
      });
  };
  // Folding keeps the open conversation open: it moves over the list. The
  // conversation screen returns here when there is room again.
  const wide = Boolean(split);
  const wasWide = useRef(wide);
  useEffect(() => {
    const folded = wasWide.current && !wide;
    wasWide.current = wide;
    if (folded && focused && selected) open(selected, true);
    // `open` is recreated every render; only the layout change matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [wide]);
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
      open(result.id);
    },
  });
  // A second tap can land before the pending state renders; one request only.
  const creating = useRef(false);
  const start = () => {
    if (creating.current) return;
    creating.current = true;
    create.mutate(undefined, {
      onSettled: () => {
        creating.current = false;
      },
    });
  };
  const refetchSessions = sessions.refetch;
  useConversationListRefresh(focused, refetchSessions);
  const pull = usePullToRefresh(focused, () => sessions.refetch());
  const list = sessions.data ?? [];
  return (
    <PageRoot nested={nested}>
      <View
        ref={ref}
        onLayout={onLayout}
        style={{ flex: 1, flexDirection: 'row' }}
      >
        <View style={split ? { width: split.leading } : { flex: 1 }}>
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
                accessibilityState={{
                  selected: Boolean(split) && item.id === selected,
                }}
                onPress={() => open(item.id)}
                style={({ pressed }) => ({
                  minHeight: 64,
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 12,
                  paddingVertical: 14,
                  paddingHorizontal: 4,
                  borderRadius: 14,
                  backgroundColor:
                    pressed || (split && item.id === selected)
                      ? c.limeSoft
                      : 'transparent',
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
                  <View
                    style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}
                  >
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
        </View>
        {split ? (
          <>
            <View
              style={{ width: conversationSplit.gap, alignItems: 'center' }}
            >
              <View
                style={{
                  flex: 1,
                  width: StyleSheet.hairlineWidth,
                  backgroundColor: c.rule,
                }}
              />
            </View>
            <View style={{ width: split.trailing }}>
              {selected ? (
                <Conversation key={selected} id={selected} embedded />
              ) : (
                <View
                  style={{ flex: 1, justifyContent: 'center', padding: 20 }}
                >
                  <EmptyState
                    title="Pick a conversation"
                    detail="Choose one from the list to read it here, or start a new one."
                  />
                </View>
              )}
            </View>
          </>
        ) : null}
      </View>
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
