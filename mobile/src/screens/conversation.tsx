import { AttachmentMenu, Choice } from '../ui/native-controls';
import { NativeField, type NativeFieldRef } from '../ui/native-field';
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Stack, router, useIsFocused } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Alert,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  type ScrollViewInstance,
  type LayoutChangeEvent,
  type LayoutRectangle,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
  type ViewInstance,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { AskAnswer, JsonValue, PendingAsk, StreamState } from '../core';
import { useSession } from '../state/session';
import {
  useAskDraft,
  useChatDraft,
  type Picked,
} from '../state/use-chat-draft';
import { useRefreshOnReturn } from '../state/use-refresh-on-return';
import { useRunStream } from '../state/use-run-stream';
import {
  checksSpent,
  placeHeldReplies,
  shownHeldReplies,
  type HeldReply,
} from '../state/settled-run';
import { useHeldReplies } from '../state/use-held-replies';
import { markConversationWorking } from '../state/conversation-follow';
import { useConversationLifetime } from '../state/conversation-lifetime';
import { AskCard } from '../ui/ask-card';
import { Button, IconButton } from '../ui/button';
import { Glyph } from '../ui/glyph';
import { LiveTranscript, TranscriptMessage } from '../ui/transcript';
import { Busy, Egg, Notice, errorText } from '../ui/primitives';
import { GlyphTile, Monogram } from '../ui/rows';
import { Text, type } from '../ui/text';
import { palette as c, radii } from '../ui/theme';

const suggestions = [
  'Build a tiny tool that tracks my week',
  'Improve one of my Apps',
  'Think through an idea with me',
];

/**
 * One conversation: transcript, live run, questions and composer. It is the
 * whole chat screen on a compact width, and the trailing pane beside the
 * conversation list where the Agent screen has room for both (`embedded`).
 */
export function Conversation(props: { id: string; embedded?: boolean }) {
  // A provider of its own reports the insets of this view rather than the
  // window's: a vertical bar on one side, a tab bar below an embedded pane,
  // or none at all on the side that meets the conversation list.
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <ConversationBody {...props} />
    </SafeAreaProvider>
  );
}

function ConversationBody({
  id,
  embedded = false,
}: {
  id: string;
  embedded?: boolean;
}) {
  const { api, origin } = useSession();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { draft, setDraft, files, setFiles, model, setModel } =
    useChatDraft(id);
  const [problem, setProblem] = useConversationProblem(origin, id);
  const [optimisticRun, setOptimisticRun] = useState<string | null>(null);
  const [submittedAnswer, setSubmittedAnswer] = useState<{
    runId: string;
    askId: string;
  } | null>(null);
  // Where the reader is belongs to the conversation: a fold or unfold that
  // moves it to another screen reopens the same place, and follows new
  // messages only if the reader was already at the end.
  const reading = useReadingAnchor(origin, id);
  const [atBottom, setAtBottom] = useState(reading.initial.atBottom);
  // The reader's place, changed only by the reader's own scrolling: a
  // resize rewraps the text under a fixed offset, which is not a new place.
  const anchor = useRef(reading.initial);
  // While settling, every new layout of the anchored message scrolls back to
  // the place; a resize or a handoff lays text out more than once. The
  // reader's first drag ends it.
  const settle = useRef<number | null>(
    reading.initial.atBottom ? null : Number.POSITIVE_INFINITY,
  );
  const cells = useRef(new Map<number, { y: number; height: number }>());
  const width = useRef<number | null>(null);
  const settleAgain = () => {
    if (!anchor.current.atBottom) settle.current = Date.now() + SETTLE_MS;
  };
  const apply = useCallback(() => {
    if (settle.current === null || anchor.current.atBottom) return;
    if (Date.now() > settle.current) {
      settle.current = null;
      return;
    }
    const { index, fraction } = anchor.current;
    const cell = cells.current.get(index);
    if (!cell) {
      list.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
      return;
    }
    // The same share of the message: this width wraps it differently.
    list.current?.scrollToOffset({
      offset: cell.y + fraction * cell.height,
      animated: false,
    });
    if (settle.current === Number.POSITIVE_INFINITY)
      settle.current = Date.now() + SETTLE_MS;
  }, []);
  const recordCell = useCallback(
    (index: number, layout: LayoutRectangle) => {
      cells.current.set(index, { y: layout.y, height: layout.height });
      if (anchor.current.index === index) apply();
    },
    [apply],
  );
  const keepPlace = (offset: number, bottom: boolean) => {
    anchor.current = readingAt(cells.current, offset, bottom);
    reading.save(anchor.current);
  };
  const list = useRef<FlatList<JsonValue>>(null);
  const frame = useRef<ViewInstance>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const sending = useRef(false);
  const composer = useRef<NativeFieldRef>(null);
  const composerScroll = useRef<ScrollViewInstance>(null);
  // Work outlives a fold or unfold that moves this conversation to another
  // screen; it stops when no screen shows the conversation any more.
  // A problem from an earlier visit does not greet a fresh one.
  const clearProblem = useCallback(() => setProblem(null), [setProblem]);
  const lifetimeSignal = useConversationLifetime(origin, id, clearProblem);
  // One run request at a time per conversation, across every screen showing it.
  const runKey = [origin, 'conversation-run', id];
  const requesting = useIsMutating({ mutationKey: runKey }) > 0;
  const session = useQuery({
    queryKey: [origin, 'session', id],
    queryFn: ({ signal }) => api!.session(id, signal),
    enabled: Boolean(api),
  });
  // Another client may add messages or start a run while a pushed screen
  // covers this one. Joining any read in flight keeps background checks whole.
  useRefreshOnReturn(useIsFocused(), () => {
    if (api) void session.refetch({ cancelRefetch: false });
  });
  const config = useQuery({
    queryKey: [origin, 'config'],
    queryFn: ({ signal }) => api!.config(signal),
    enabled: Boolean(api),
  });
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const detail = session.data;
  const refetchSession = session.refetch;
  const selectedModel =
    model ??
    (detail?.providerId && detail.modelId
      ? { providerId: detail.providerId, modelId: detail.modelId }
      : config.data?.defaultModel);
  const choices =
    config.data?.providers.flatMap((provider) =>
      provider.models.map((item) => ({
        ...item,
        providerId: provider.id,
        providerName: provider.name,
      })),
    ) ?? [];

  // The run the composer, questions and environment requests belong to.
  const runId = detail?.activeRun?.id ?? optimisticRun;
  // The stream follows its run until it lets go with the state it showed,
  // even after the conversation stops listing the run as active.
  const [following, setFollowing] = useState<string | null>(null);
  if (runId && runId !== following) setFollowing(runId);
  const streamRunId = runId ?? following;
  const { held, end: holdReply, recheck } = useHeldReplies(id, refetchSession);
  const refresh = useCallback(
    async (ended?: { runId: string; state: StreamState }) => {
      if (lifetimeSignal().aborted) return true;
      const result = await refetchSession();
      if (lifetimeSignal().aborted) return true;
      if (result.error) throw result.error;
      await queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
      await queryClient.invalidateQueries({ queryKey: [origin, 'apps'] });
      const data = result.data;
      if (!data) return false;
      if (data.activeRun) {
        setOptimisticRun(null);
        return false;
      }
      // Only the stream lets go of its run, with the exact state it showed.
      // A stop can end the run before its partial reply is saved; that reply
      // is kept and re-checked rather than dropped.
      if (!ended) return false;
      holdReply(id, ended.runId, data, ended.state);
      setOptimisticRun((current) => (current === ended.runId ? null : current));
      setFollowing((current) => (current === ended.runId ? null : current));
      return true;
    },
    [refetchSession, queryClient, origin, lifetimeSignal, holdReply, id],
  );
  const reconcile = useCallback(
    (endedRunId: string, shown: StreamState) =>
      refresh({ runId: endedRunId, state: shown }),
    [refresh],
  );
  const stream = useRunStream(api, streamRunId, reconcile);
  const heldShown = placeHeldReplies(
    detail?.messages ?? [],
    shownHeldReplies(held, id, detail),
  );
  const heldReply = (entry: HeldReply) => (
    <LiveTranscript
      key={entry.runId}
      state={entry.state}
      settled
      status={
        checksSpent(entry)
          ? 'Stopped · this reply isn’t saved on your server yet'
          : 'Stopped · checking for the saved reply'
      }
      action={
        checksSpent(entry)
          ? { label: 'Check again', onPress: recheck }
          : undefined
      }
    />
  );
  const ask = stream.state.lastSeq
    ? stream.state.pendingAsk
    : detail?.activeRun?.pendingAsk;
  const answerSubmitted = Boolean(
    ask &&
    runId &&
    ((submittedAnswer?.runId === runId &&
      submittedAnswer.askId === ask.askId) ||
      (detail?.activeRun?.id === runId &&
        detail.activeRun.answeredAskId === ask.askId)),
  );
  const env = stream.state.lastSeq
    ? stream.state.pendingEnv
    : detail?.activeRun?.pendingEnvRequest;

  const send = useMutation({
    mutationKey: runKey,
    mutationFn: async () => {
      const signal = lifetimeSignal();
      const text = (composer.current?.getText() ?? draft).trim();
      if (!selectedModel) throw new Error('Choose a configured model first.');
      if (streamRunId)
        throw new Error('Wait for the current reply or stop it first.');
      const attachmentIds: string[] = [];
      for (const file of files.filter((item) => !item.image)) {
        const blob = new File(file.uri);
        await api!.uploadAttachment(
          id,
          file.id,
          blob,
          file.name,
          file.mimeType,
          signal,
        );
        attachmentIds.push(file.id);
      }
      // The list follows this conversation even if we leave before the
      // request lands or its result is read.
      markConversationWorking(queryClient, origin!, id);
      return api!.createRun(
        {
          sessionId: id,
          ...selectedModel,
          content: text ? [{ type: 'text', text }] : [],
          attachmentIds,
          images: files
            .filter((item) => item.image)
            .map((item) => ({ data: item.image!, mimeType: item.mimeType })),
        },
        signal,
      );
    },
    onSuccess: async (result) => {
      if (lifetimeSignal().aborted) return;
      setOptimisticRun(result.runId);
      setDraft('');
      setFiles([]);
      setProblem(null);
      setAtBottom(true);
      // A sent message is read from the end.
      anchor.current = { ...anchor.current, atBottom: true };
      reading.save(anchor.current);
      await session.refetch();
    },
    onError: async (error) => {
      if (lifetimeSignal().aborted) return;
      // A timed-out POST may have started the run. Never replay it blindly.
      const snapshot = await session.refetch();
      if (lifetimeSignal().aborted) return;
      setProblem(
        snapshot.data?.activeRun
          ? 'Your request reached the server. Following the active run; your draft is kept until you review it.'
          : `${errorText(error)} Your draft is kept. Check the conversation before sending again.`,
      );
    },
    onSettled: () => {
      sending.current = false;
    },
  });
  const answer = useMutation({
    mutationFn: (submission: {
      runId: string;
      askId: string;
      answers: AskAnswer[];
    }) =>
      api!.answerRun(
        submission.runId,
        submission.askId,
        submission.answers,
        lifetimeSignal(),
      ),
    onSuccess: async (_result, submission) => {
      // The answer is on the server; its unsent copy is no longer needed.
      queryClient.removeQueries({
        queryKey: [origin, 'ask-draft', id, submission.askId],
      });
      if (lifetimeSignal().aborted) return;
      setSubmittedAnswer({ runId: submission.runId, askId: submission.askId });
      await refresh();
    },
    onError: async (error) => {
      if (!lifetimeSignal().aborted) {
        setProblem(errorText(error));
        await session.refetch();
      }
    },
  });
  const cancel = useMutation({
    mutationFn: (targetRunId: string) =>
      api!.cancelRun(targetRunId, lifetimeSignal()),
    // The stream lets go of the stopped run itself, with its final state.
    onSuccess: () => refresh(),
    onError: (error) => {
      if (!lifetimeSignal().aborted) setProblem(errorText(error));
    },
  });
  const retryRun = useMutation({
    mutationKey: runKey,
    mutationFn: () => {
      markConversationWorking(queryClient, origin!, id);
      return api!.createRun(
        {
          sessionId: id,
          providerId: selectedModel!.providerId,
          modelId: selectedModel!.modelId,
          retry: true,
          expectedSessionUpdatedAt: detail!.updatedAt,
        },
        lifetimeSignal(),
      );
    },
    onSuccess: async (result) => {
      if (lifetimeSignal().aborted) return;
      setOptimisticRun(result.runId);
      setProblem(null);
      await session.refetch();
    },
    onError: async (error) => {
      if (lifetimeSignal().aborted) return;
      setProblem(`${errorText(error)} Check the conversation before retrying.`);
      await session.refetch();
    },
  });
  const addFiles = (picked: Picked[]) => {
    if (lifetimeSignal().aborted) return;
    if (picked.some((file) => file.size > 25 * 1024 * 1024 || file.size <= 0))
      throw new Error('Files must be non-empty and no larger than 25 MiB.');
    const combined = [...files, ...picked];
    if (combined.length > 6)
      throw new Error('Attach up to six photos or files per message.');
    if (
      combined.some((file) => (file.image?.length ?? 0) > 8_000_000) ||
      combined.reduce((total, file) => total + (file.image?.length ?? 0), 0) >
        24_000_000
    )
      throw new Error(
        'These photos are too large. Choose fewer or smaller images.',
      );
    setFiles(combined);
  };
  const choose = async (kind: 'photo' | 'file') => {
    try {
      setProblem(null);
      if (kind === 'file') {
        const result = await DocumentPicker.getDocumentAsync({
          multiple: true,
          copyToCacheDirectory: true,
        });
        if (!result.canceled)
          addFiles(
            result.assets.map((item) => ({
              id: Crypto.randomUUID(),
              name: item.name,
              uri: item.uri,
              mimeType: item.mimeType ?? 'application/octet-stream',
              size: item.size ?? new File(item.uri).size,
            })),
          );
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsMultipleSelection: true,
          selectionLimit: Math.max(1, 6 - files.length),
          quality: 0.7,
          base64: true,
        });
        if (!result.canceled)
          addFiles(
            result.assets.map((item) => {
              if (!item.base64)
                throw new Error(
                  'This photo could not be read. Try choosing it as a file.',
                );
              // Expo iOS exports JPEG base64 even when the file metadata keeps PNG/HEIC.
              const mimeType = item.base64.startsWith('/9j/')
                ? 'image/jpeg'
                : (item.mimeType ?? 'image/jpeg');
              if (
                ![
                  'image/png',
                  'image/jpeg',
                  'image/webp',
                  'image/gif',
                ].includes(mimeType)
              )
                throw new Error('Choose a JPEG, PNG, WebP, or GIF photo.');
              return {
                id: Crypto.randomUUID(),
                name: item.fileName ?? 'Photo.jpg',
                uri: item.uri,
                mimeType,
                size: item.fileSize ?? Math.floor(item.base64.length * 0.75),
                image: item.base64,
              };
            }),
          );
      }
    } catch (error) {
      setProblem(errorText(error));
    }
  };
  const submit = () => {
    if (sending.current || queryClient.isMutating({ mutationKey: runKey }))
      return;
    sending.current = true;
    setProblem(null);
    send.mutate();
  };
  // The keyboard replaces the home-indicator inset under the composer.
  const [keyboardShown, setKeyboardShown] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () =>
      setKeyboardShown(true),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () =>
      setKeyboardShown(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  useEffect(() => {
    if (atBottom) list.current?.scrollToEnd({ animated: false });
  }, [stream.state.lastSeq, detail?.messages.length, atBottom]);
  const busy = requesting || send.isPending || retryRun.isPending;
  const lastRun = detail?.runs.at(-1);
  const lastMessage = detail?.messages.at(-1);
  // Match the server's retry contract. An interrupted run can end with an
  // aborted assistant message, which is not a retryable provider error.
  const retryable =
    lastMessage !== null &&
    typeof lastMessage === 'object' &&
    !Array.isArray(lastMessage) &&
    lastMessage.role === 'assistant' &&
    lastMessage.stopReason === 'error';
  const status = !runId
    ? 'Stopping…'
    : stream.connection === 'live'
      ? 'Working on your server'
      : stream.connection === 'paused'
        ? 'Updates paused · still working'
        : 'Reconnecting…';
  const canSend =
    !busy &&
    !streamRunId &&
    Boolean(selectedModel) &&
    Boolean(draft.trim() || files.length);
  return (
    <View
      ref={frame}
      style={{
        flex: 1,
        backgroundColor: c.paper,
        // A vertical bar arrives as an inset on one side only.
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
      onLayout={() =>
        frame.current?.measureInWindow((_x, y) => setKeyboardOffset(y))
      }
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {embedded ? (
          <View
            style={{
              paddingTop: insets.top + 14,
              paddingHorizontal: 20,
              paddingBottom: 10,
              gap: 4,
            }}
          >
            <Text style={type.meta}>Conversation</Text>
            <Text
              accessibilityRole="header"
              numberOfLines={2}
              maxFontSizeMultiplier={1.6}
              style={type.title}
            >
              {detail?.title || 'New conversation'}
            </Text>
          </View>
        ) : (
          <Stack.Screen
            options={{
              title: detail?.title || 'Conversation',
              headerTransparent: false,
            }}
          />
        )}
        {session.isPending ? (
          <Busy label="Opening conversation" />
        ) : session.error && !detail ? (
          <View style={{ flex: 1, padding: 16 }}>
            <Notice
              tone="danger"
              title="Couldn’t load this conversation"
              detail={errorText(session.error)}
              action={{
                label: 'Try again',
                onPress: () => void session.refetch(),
              }}
            />
          </View>
        ) : (
          <RecordCell value={recordCell}>
            <FlatList
              style={{ flex: 1 }}
              contentInsetAdjustmentBehavior="automatic"
              ref={list}
              data={detail?.messages ?? []}
              extraData={held}
              keyExtractor={(_, index) => String(index)}
              contentContainerStyle={{
                paddingHorizontal: 16,
                paddingTop: 12,
                paddingBottom: 24,
                gap: 18,
              }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onLayout={(event) => {
                const next = event.nativeEvent.layout.width;
                if (width.current !== null && width.current !== next) {
                  settleAgain();
                  apply();
                }
                width.current = next;
              }}
              onScroll={(event) => {
                const { contentOffset, layoutMeasurement, contentSize } =
                  event.nativeEvent;
                setAtBottom(
                  contentOffset.y + layoutMeasurement.height >=
                    contentSize.height - 100,
                );
              }}
              onScrollBeginDrag={() => {
                settle.current = null;
              }}
              onScrollEndDrag={(event) => {
                const { contentOffset, layoutMeasurement, contentSize } =
                  event.nativeEvent;
                keepPlace(
                  contentOffset.y,
                  contentOffset.y + layoutMeasurement.height >=
                    contentSize.height - 100,
                );
              }}
              onMomentumScrollEnd={(event) => {
                const { contentOffset, layoutMeasurement, contentSize } =
                  event.nativeEvent;
                keepPlace(
                  contentOffset.y,
                  contentOffset.y + layoutMeasurement.height >=
                    contentSize.height - 100,
                );
              }}
              scrollEventThrottle={100}
              CellRendererComponent={RecordingCell}
              onScrollToIndexFailed={(info) => {
                // Rows above it are not measured yet: get near, then restore.
                list.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                // Only while settling: the rough scroll may already have laid
                // out the row and restored the place exactly.
                setTimeout(apply, 50);
              }}
              onContentSizeChange={() => {
                if (settle.current !== null) {
                  if ((detail?.messages.length ?? 0) > anchor.current.index)
                    apply();
                  return;
                }
                if (atBottom) list.current?.scrollToEnd({ animated: false });
              }}
              renderItem={({ item, index }) => {
                const after = heldShown.after.get(index);
                return after ? (
                  <View style={{ gap: 18 }}>
                    <TranscriptMessage value={item} />
                    {after.map(heldReply)}
                  </View>
                ) : (
                  <TranscriptMessage value={item} />
                );
              }}
              ListEmptyComponent={
                !streamRunId && !heldShown.rest.length ? (
                  <View style={{ gap: 14, paddingTop: 24 }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        gap: 8,
                        alignItems: 'flex-end',
                      }}
                    >
                      <Egg size={22} outline />
                      <Egg size={30} />
                    </View>
                    <Text accessibilityRole="header" style={type.display}>
                      Start with an idea.
                    </Text>
                    <Text style={type.callout}>
                      Build an App, explore your data or pick up something
                      unfinished. Photos and files can help explain what you
                      mean.
                    </Text>
                    <View style={{ gap: 8, marginTop: 6 }}>
                      {suggestions.map((text) => (
                        <Pressable
                          key={text}
                          accessibilityRole="button"
                          accessibilityHint="Puts this in your message"
                          disabled={busy}
                          onPress={() => setDraft(text)}
                          style={({ pressed }) => ({
                            minHeight: 44,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingHorizontal: 14,
                            paddingVertical: 10,
                            borderRadius: 16,
                            backgroundColor: pressed ? c.limeSoft : c.card,
                          })}
                        >
                          <Glyph name="sparkle" size={13} color={c.moss} />
                          <Text
                            style={[type.callout, { flex: 1, color: c.ink }]}
                          >
                            {text}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : undefined
              }
              ListFooterComponent={
                <View style={{ gap: 16 }}>
                  {heldShown.rest.map(heldReply)}
                  {streamRunId ? (
                    <LiveTranscript state={stream.state} status={status} />
                  ) : null}
                  {ask && runId ? (
                    answerSubmitted ? (
                      <Notice
                        tone="info"
                        title="Answer sent"
                        detail="Your answer is saved on the server. Waiting for your Agent to continue."
                      />
                    ) : (
                      <PendingAskCard
                        key={ask.askId}
                        conversation={id}
                        ask={ask}
                        busy={answer.isPending}
                        onAnswer={(answers) =>
                          answer.mutate({ runId, askId: ask.askId, answers })
                        }
                      />
                    )
                  ) : null}
                  {env && runId ? (
                    <Notice
                      tone="info"
                      title="Continue in Hatch web"
                      detail={`${env.reason} Open this conversation in your browser to provide environment values securely.`}
                      action={{
                        label: 'Open conversation in browser',
                        onPress: () =>
                          void WebBrowser.openBrowserAsync(
                            `${origin}/agent/${encodeURIComponent(id)}`,
                          ).catch((error: unknown) =>
                            setProblem(errorText(error)),
                          ),
                      }}
                    />
                  ) : null}
                  {!runId &&
                  lastRun &&
                  ['failed', 'interrupted', 'cancelled'].includes(
                    lastRun.status,
                  ) ? (
                    <Notice
                      tone={
                        lastRun.status === 'cancelled' ? 'neutral' : 'danger'
                      }
                      title={
                        lastRun.status === 'cancelled'
                          ? 'Run stopped'
                          : 'The Agent couldn’t finish'
                      }
                      detail={
                        lastRun.error ??
                        'Your conversation is saved. You can continue with another message.'
                      }
                      action={
                        selectedModel &&
                        retryable &&
                        lastRun.status !== 'cancelled'
                          ? {
                              label: retryRun.isPending
                                ? 'Retrying…'
                                : 'Retry this turn',
                              onPress: () => {
                                if (!requesting) retryRun.mutate();
                              },
                            }
                          : undefined
                      }
                    />
                  ) : null}
                  {(detail?.appIds ?? []).map((appId) => {
                    const name =
                      apps.data?.find((app) => app.id === appId)?.name ?? 'App';
                    return (
                      <Pressable
                        key={appId}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${name}`}
                        onPress={() =>
                          router.push({
                            pathname: '/apps/[id]',
                            params: { id: appId },
                          })
                        }
                        style={({ pressed }) => ({
                          minHeight: 56,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                          padding: 10,
                          paddingRight: 16,
                          borderRadius: 20,
                          backgroundColor: pressed ? c.limeSoft : c.card,
                        })}
                      >
                        <Monogram name={name} size={36} />
                        <View style={{ flex: 1 }}>
                          <Text style={type.meta}>Built here</Text>
                          <Text style={type.heading} numberOfLines={1}>
                            Open {name}
                          </Text>
                        </View>
                        <Glyph name="chevron" size={12} color={c.inkFaint} />
                      </Pressable>
                    );
                  })}
                </View>
              }
            />
          </RecordCell>
        )}
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: keyboardShown ? 10 : Math.max(insets.bottom, 12),
            backgroundColor: c.card,
            borderTopLeftRadius: radii.sheet,
            borderTopRightRadius: radii.sheet,
            shadowColor: c.ink,
            shadowOpacity: 0.08,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: -4 },
            gap: 8,
            flexShrink: 1,
            maxHeight: '75%',
          }}
        >
          <ScrollView
            ref={composerScroll}
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ gap: 10 }}
            keyboardShouldPersistTaps="handled"
            onLayout={() =>
              composerScroll.current?.scrollToEnd({ animated: false })
            }
            onContentSizeChange={() =>
              composerScroll.current?.scrollToEnd({ animated: false })
            }
          >
            {problem ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: 12,
                  paddingRight: 4,
                  borderRadius: 16,
                  backgroundColor: c.dangerSoft,
                }}
              >
                <Text
                  accessibilityRole="alert"
                  style={[type.small, { flex: 1, color: c.danger }]}
                >
                  {problem}
                </Text>
                <IconButton
                  label="Dismiss message"
                  glyph="close"
                  tone="clear"
                  size={32}
                  onPress={() => setProblem(null)}
                />
              </View>
            ) : null}
            {config.error ? (
              <Notice
                tone="danger"
                title="Couldn’t load models"
                detail={errorText(config.error)}
                action={{
                  label: 'Try again',
                  onPress: () => void config.refetch(),
                }}
              />
            ) : null}
            {files.length ? (
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
                {files.map((file) => (
                  <Pressable
                    key={file.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.image ? 'photo' : file.name}`}
                    disabled={busy}
                    onPress={() =>
                      setFiles((value) =>
                        value.filter((item) => item.id !== file.id),
                      )
                    }
                    style={({ pressed }) => ({
                      minHeight: 48,
                      maxWidth: 220,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      padding: 6,
                      paddingRight: 10,
                      borderRadius: 14,
                      backgroundColor: pressed ? c.sunken : c.paper,
                      opacity: busy ? 0.5 : 1,
                    })}
                  >
                    {file.image ? (
                      <Image
                        accessible={false}
                        source={{ uri: file.uri }}
                        style={{ width: 36, height: 36, borderRadius: 9 }}
                      />
                    ) : (
                      <GlyphTile glyph="file" size={36} />
                    )}
                    <Text
                      style={[type.small, { flexShrink: 1, color: c.ink }]}
                      numberOfLines={1}
                    >
                      {file.name}
                    </Text>
                    <Glyph name="close" size={11} color={c.inkSoft} />
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <NativeField
              ref={composer}
              variant="bare"
              label="Message your Agent"
              maxLength={50000}
              multiline
              value={draft}
              onChange={setDraft}
              unavailable={busy}
              placeholder={
                runId
                  ? 'Draft your next message…'
                  : 'What would you like to make?'
              }
            />
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <AttachmentMenu
              disabled={busy || files.length >= 6}
              onChoose={(kind) => void choose(kind)}
            />
            {choices.length ? (
              <Choice
                compact
                label="Model"
                glyph="model"
                value={
                  selectedModel
                    ? `${selectedModel.providerId}:${selectedModel.modelId}`
                    : ''
                }
                // The chip names the model; the menu also names its provider.
                options={choices.map((item) => ({
                  label: `${item.providerName} · ${item.name}`,
                  short: item.name,
                  value: `${item.providerId}:${item.modelId}`,
                }))}
                disabled={Boolean(runId) || busy}
                onChange={(value) => {
                  const item = choices.find(
                    (option) =>
                      `${option.providerId}:${option.modelId}` === value,
                  );
                  if (item)
                    setModel({
                      providerId: item.providerId,
                      modelId: item.modelId,
                    });
                }}
              />
            ) : config.data ? (
              <Text
                style={type.meta}
                numberOfLines={1}
                accessibilityHint="Configure a provider in Hatch on the web"
              >
                No model
              </Text>
            ) : null}
            <Text style={[type.meta, { flex: 1 }]} numberOfLines={1}>
              {files.length ? `${files.length}/6` : ''}
            </Text>
            {runId ? (
              <Button
                variant="danger"
                size="small"
                glyph="stop"
                label={cancel.isPending ? 'Stopping…' : 'Stop'}
                busy={cancel.isPending}
                onPress={() =>
                  Alert.alert(
                    'Stop this run?',
                    'Work already completed is kept.',
                    [
                      { text: 'Keep running', style: 'cancel' },
                      {
                        text: 'Stop',
                        style: 'destructive',
                        onPress: () => cancel.mutate(runId),
                      },
                    ],
                  )
                }
              />
            ) : null}
            <IconButton
              label={send.isPending ? 'Sending…' : 'Send'}
              glyph="send"
              tone={canSend ? 'moss' : 'sunken'}
              disabled={!canSend}
              onPress={submit}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * The conversation's latest problem, shared by every screen showing it, so a
 * send that fails after a fold handed the conversation over still says so.
 */
function useConversationProblem(origin: string | null, id: string) {
  const client = useQueryClient();
  const { data = null } = useQuery<string | null>({
    queryKey: [origin, 'conversation-problem', id],
    queryFn: skipToken,
    initialData: null,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const set = useCallback(
    (problem: string | null) =>
      client.setQueryData<string | null>(
        [origin, 'conversation-problem', id],
        problem,
      ),
    [client, origin, id],
  );
  return [data, set] as const;
}

/** A pending question whose unsent answers belong to the conversation. */
function PendingAskCard({
  conversation,
  ask,
  busy,
  onAnswer,
}: {
  conversation: string;
  ask: PendingAsk;
  busy: boolean;
  onAnswer: (answers: AskAnswer[]) => void;
}) {
  const { saved, save } = useAskDraft(conversation, ask.askId);
  return (
    <AskCard
      ask={ask}
      busy={busy}
      saved={saved}
      onDraft={save}
      onAnswer={onAnswer}
    />
  );
}

/** How long layout passes after a resize or handoff may still move text. */
const SETTLE_MS = 1200;

type ReadingAnchor = { atBottom: boolean; index: number; fraction: number };
const atEnd: ReadingAnchor = { atBottom: true, index: 0, fraction: 0 };

/** The message at the top of the view, and how far into it the reader is. */
function readingAt(
  cells: Map<number, { y: number; height: number }>,
  top: number,
  atBottom: boolean,
): ReadingAnchor {
  let next: { index: number; y: number } | null = null;
  for (const [index, cell] of cells) {
    if (top >= cell.y && top < cell.y + cell.height)
      return {
        atBottom,
        index,
        fraction: Math.round(((top - cell.y) / cell.height) * 100) / 100,
      };
    if (cell.y >= top && (!next || cell.y < next.y))
      next = { index, y: cell.y };
  }
  return { atBottom, index: next?.index ?? 0, fraction: 0 };
}

const RecordCell = createContext<
  (index: number, layout: LayoutRectangle) => void
>(() => {});

/** A transcript row that reports where it sits, for the reading anchor. */
function RecordingCell({
  index,
  onLayout,
  onFocusCapture,
  style,
  children,
}: {
  index: number;
  onLayout?: (event: LayoutChangeEvent) => void;
  onFocusCapture?: ViewProps['onFocusCapture'];
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const record = useContext(RecordCell);
  return (
    <View
      style={style}
      onFocusCapture={onFocusCapture}
      onLayout={(event) => {
        onLayout?.(event);
        record(index, event.nativeEvent.layout);
      }}
    >
      {children}
    </View>
  );
}

/**
 * The transcript position of a conversation, read when a screen showing it
 * mounts and written as the reader scrolls. Kept by message rather than
 * offset: the other screen's width reflows the text.
 */
function useReadingAnchor(origin: string | null, id: string) {
  const client = useQueryClient();
  const [initial] = useState(
    () => client.getQueryData<ReadingAnchor>([origin, 'reading', id]) ?? atEnd,
  );
  const last = useRef(initial);
  const save = useCallback(
    (anchor: ReadingAnchor) => {
      if (
        anchor.atBottom === last.current.atBottom &&
        anchor.index === last.current.index &&
        anchor.fraction === last.current.fraction
      )
        return;
      last.current = anchor;
      client.setQueryData<ReadingAnchor>([origin, 'reading', id], anchor);
    },
    [client, origin, id],
  );
  return { initial, save };
}
