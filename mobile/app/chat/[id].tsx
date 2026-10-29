import { AttachmentMenu, Choice } from '../../src/ui/native-controls';
import { NativeField, type NativeFieldRef } from '../../src/ui/native-field';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  type ViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AskAnswer, JsonValue } from '../../src/core';
import { useSession } from '../../src/state/session';
import { useChatDraft, type Picked } from '../../src/state/use-chat-draft';
import { useRunStream } from '../../src/state/use-run-stream';
import { useLifetimeSignal } from '../../src/state/use-lifetime-signal';
import { AskCard } from '../../src/ui/ask-card';
import { Button, IconButton } from '../../src/ui/button';
import { Glyph } from '../../src/ui/glyph';
import { LiveTranscript, TranscriptMessage } from '../../src/ui/transcript';
import { Busy, Egg, Notice, errorText } from '../../src/ui/primitives';
import { GlyphTile, Monogram } from '../../src/ui/rows';
import { Text, type } from '../../src/ui/text';
import { palette as c, radii } from '../../src/ui/theme';

const suggestions = [
  'Build a tiny tool that tracks my week',
  'Improve one of my Apps',
  'Think through an idea with me',
];

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin } = useSession();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { draft, setDraft, files, setFiles } = useChatDraft(id);
  const [problem, setProblem] = useState<string | null>(null);
  const [optimisticRun, setOptimisticRun] = useState<string | null>(null);
  const [model, setModel] = useState<{
    providerId: string;
    modelId: string;
  } | null>(null);
  const [submittedAnswer, setSubmittedAnswer] = useState<{
    runId: string;
    askId: string;
  } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<FlatList<JsonValue>>(null);
  const frame = useRef<ViewInstance>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const sending = useRef(false);
  const composer = useRef<NativeFieldRef>(null);
  const composerScroll = useRef<ScrollViewInstance>(null);
  const lifetimeSignal = useLifetimeSignal();
  const session = useQuery({
    queryKey: [origin, 'session', id],
    queryFn: ({ signal }) => api!.session(id, signal),
    enabled: Boolean(api),
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

  const runId = detail?.activeRun?.id ?? optimisticRun;
  const refresh = useCallback(async () => {
    if (lifetimeSignal().aborted) return true;
    const result = await refetchSession();
    if (lifetimeSignal().aborted) return true;
    if (result.error) throw result.error;
    await queryClient.invalidateQueries({ queryKey: [origin, 'sessions'] });
    await queryClient.invalidateQueries({ queryKey: [origin, 'apps'] });
    setOptimisticRun(null);
    return result.data?.activeRun === null;
  }, [refetchSession, queryClient, origin, lifetimeSignal]);
  const stream = useRunStream(api, runId, refresh);
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
    mutationFn: async () => {
      const signal = lifetimeSignal();
      const text = (composer.current?.getText() ?? draft).trim();
      if (!selectedModel) throw new Error('Choose a configured model first.');
      if (runId)
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
    onSuccess: refresh,
    onError: (error) => {
      if (!lifetimeSignal().aborted) setProblem(errorText(error));
    },
  });
  const retryRun = useMutation({
    mutationFn: () =>
      api!.createRun(
        {
          sessionId: id,
          providerId: selectedModel!.providerId,
          modelId: selectedModel!.modelId,
          retry: true,
          expectedSessionUpdatedAt: detail!.updatedAt,
        },
        lifetimeSignal(),
      ),
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
    if (sending.current) return;
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
  const busy = send.isPending || retryRun.isPending;
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
  const status =
    stream.connection === 'live'
      ? 'Working on your server'
      : stream.connection === 'paused'
        ? 'Updates paused · still working'
        : 'Reconnecting…';
  const canSend =
    !busy &&
    !runId &&
    Boolean(selectedModel) &&
    Boolean(draft.trim() || files.length);
  return (
    <View
      ref={frame}
      style={{ flex: 1, backgroundColor: c.paper }}
      onLayout={() =>
        frame.current?.measureInWindow((_x, y) => setKeyboardOffset(y))
      }
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        <Stack.Screen
          options={{
            title: detail?.title || 'Conversation',
            headerTransparent: false,
          }}
        />
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
          <FlatList
            style={{ flex: 1 }}
            contentInsetAdjustmentBehavior="automatic"
            ref={list}
            data={detail?.messages ?? []}
            keyExtractor={(_, index) => String(index)}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingTop: 12,
              paddingBottom: 24,
              gap: 18,
            }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => {
              const { contentOffset, layoutMeasurement, contentSize } =
                event.nativeEvent;
              setAtBottom(
                contentOffset.y + layoutMeasurement.height >=
                  contentSize.height - 100,
              );
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (atBottom) list.current?.scrollToEnd({ animated: false });
            }}
            renderItem={({ item }) => <TranscriptMessage value={item} />}
            ListEmptyComponent={
              !runId ? (
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
                    unfinished. Photos and files can help explain what you mean.
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
                        <Text style={[type.callout, { flex: 1, color: c.ink }]}>
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
                {runId ? (
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
                    <AskCard
                      key={ask.askId}
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
                    tone={lastRun.status === 'cancelled' ? 'neutral' : 'danger'}
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
                              if (!retryRun.isPending) retryRun.mutate();
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
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Choice
                label="Model"
                glyph="model"
                value={
                  selectedModel
                    ? `${selectedModel.providerId}:${selectedModel.modelId}`
                    : ''
                }
                options={
                  choices.length
                    ? choices.map((item) => ({
                        label: `${item.providerName} · ${item.name}`,
                        value: `${item.providerId}:${item.modelId}`,
                      }))
                    : [
                        {
                          label: 'Configure a provider in Hatch web',
                          value: '',
                        },
                      ]
                }
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
            </View>
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
            <Text style={[type.meta, { flex: 1 }]} numberOfLines={1}>
              {files.length ? `${files.length} of 6 attached` : ''}
            </Text>
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
