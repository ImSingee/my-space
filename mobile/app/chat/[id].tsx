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
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { AskAnswer, JsonValue } from '../../src/core';
import { useSession } from '../../src/state/session';
import { useChatDraft, type Picked } from '../../src/state/use-chat-draft';
import { useRunStream } from '../../src/state/use-run-stream';
import { useLifetimeSignal } from '../../src/state/use-lifetime-signal';
import { AskCard } from '../../src/ui/ask-card';
import { LiveTranscript, TranscriptMessage } from '../../src/ui/transcript';
import {
  Action,
  Busy,
  Notice,
  Text,
  TextInput,
  errorText,
  styles,
  usePalette,
} from '../../src/ui/primitives';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin } = useSession();
  const c = usePalette();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { draft, setDraft, files, setFiles } = useChatDraft(id);
  const [problem, setProblem] = useState<string | null>(null);
  const [optimisticRun, setOptimisticRun] = useState<string | null>(null);
  const [model, setModel] = useState<{
    providerId: string;
    modelId: string;
  } | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [submittedAnswer, setSubmittedAnswer] = useState<{
    runId: string;
    askId: string;
  } | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<FlatList<JsonValue>>(null);
  const frame = useRef<View>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const sending = useRef(false);
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
  const choice = choices.find(
    (item) =>
      item.providerId === selectedModel?.providerId &&
      item.modelId === selectedModel?.modelId,
  );
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
      if (!selectedModel) throw new Error('Choose a configured model first.');
      if (
        files.some((file) => file.image) &&
        choice &&
        !choice.input.includes('image')
      )
        throw new Error(
          'Choose a model that supports images, or attach the image as a file.',
        );
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
          content: draft.trim() ? [{ type: 'text', text: draft.trim() }] : [],
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
    mutationFn: () => api!.cancelRun(runId!, lifetimeSignal()),
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
  return (
    <View
      ref={frame}
      style={styles.screen}
      onLayout={() =>
        frame.current?.measureInWindow((_x, y) => setKeyboardOffset(y))
      }
    >
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        <Stack.Screen options={{ title: detail?.title ?? 'Conversation' }} />
        {session.isPending ? (
          <Busy />
        ) : session.error && !detail ? (
          <Notice
            title="Couldn’t load this conversation"
            detail={errorText(session.error)}
            action={{
              label: 'Try again',
              onPress: () => void session.refetch(),
            }}
          />
        ) : (
          <FlatList
            style={styles.screen}
            ref={list}
            data={detail?.messages ?? []}
            keyExtractor={(_, index) => String(index)}
            contentContainerStyle={styles.content}
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
                <Notice
                  title="Start with an idea."
                  detail="Build an app, explore your data, or pick up an unfinished project. Photos and files can help explain what you mean."
                />
              ) : null
            }
            ListFooterComponent={
              <View style={{ gap: 16 }}>
                {runId ? (
                  <>
                    <Text style={[styles.caption, { color: c.muted }]}>
                      {stream.connection === 'live'
                        ? 'Agent is working on your server'
                        : stream.connection === 'paused'
                          ? 'Updates paused. Your Agent keeps working.'
                          : 'Reconnecting to your Agent…'}
                    </Text>
                    <LiveTranscript state={stream.state} />
                  </>
                ) : null}
                {ask && runId ? (
                  answerSubmitted ? (
                    <Notice
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
                {(detail?.appIds ?? []).map((appId) => (
                  <Action
                    key={appId}
                    label={`Open ${apps.data?.find((app) => app.id === appId)?.name ?? 'app'}`}
                    secondary
                    onPress={() =>
                      router.push({
                        pathname: '/apps/[id]',
                        params: { id: appId },
                      })
                    }
                  />
                ))}
              </View>
            }
          />
        )}
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 10,
            paddingBottom: Math.max(insets.bottom, 12),
            backgroundColor: c.card,
            borderTopWidth: 1,
            borderTopColor: c.border,
            gap: 10,
            flexShrink: 1,
            maxHeight: '75%',
          }}
        >
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{ gap: 10 }}
            keyboardShouldPersistTaps="handled"
          >
            {problem ? (
              <Pressable onPress={() => setProblem(null)}>
                <Text
                  accessibilityRole="alert"
                  style={[styles.caption, { color: c.danger }]}
                >
                  {problem}
                </Text>
              </Pressable>
            ) : null}
            <View style={styles.row}>
              <Pressable
                disabled={Boolean(runId) || busy}
                onPress={() => setShowModels(true)}
                accessibilityRole="button"
                accessibilityLabel="Choose model"
                style={{ flex: 1, minHeight: 34, justifyContent: 'center' }}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.caption, { color: c.accent }]}
                >
                  {choice
                    ? `${choice.providerName} · ${choice.name}`
                    : (selectedModel?.modelId ?? 'Choose a model')}{' '}
                  ⌄
                </Text>
              </Pressable>
              {runId ? (
                <Pressable
                  disabled={cancel.isPending}
                  accessibilityRole="button"
                  onPress={() =>
                    Alert.alert(
                      'Stop this run?',
                      'Work already completed is kept.',
                      [
                        { text: 'Keep running', style: 'cancel' },
                        {
                          text: 'Stop',
                          style: 'destructive',
                          onPress: () => cancel.mutate(),
                        },
                      ],
                    )
                  }
                >
                  <Text style={{ color: c.danger }}>
                    {cancel.isPending ? 'Stopping…' : 'Stop'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {files.length ? (
              <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
                {files.map((file) => (
                  <Pressable
                    key={file.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${file.name}`}
                    disabled={busy}
                    onPress={() =>
                      setFiles((value) =>
                        value.filter((item) => item.id !== file.id),
                      )
                    }
                    style={{
                      backgroundColor: c.subtle,
                      padding: 10,
                      borderRadius: 10,
                    }}
                  >
                    <Text style={[styles.caption, { color: c.text }]}>
                      {file.image ? 'Photo' : file.name} ×
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <TextInput
              accessibilityLabel="Message your Agent"
              maxLength={50000}
              multiline
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
              placeholder={
                runId
                  ? 'Draft your next message…'
                  : 'What would you like to make?'
              }
              placeholderTextColor={c.muted}
              style={[
                styles.input,
                {
                  color: c.text,
                  borderColor: c.border,
                  maxHeight: 150,
                  minHeight: 52,
                },
              ]}
            />
          </ScrollView>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              disabled={busy || files.length >= 6}
              onPress={() =>
                Alert.alert('Attach to this message', undefined, [
                  {
                    text: 'Photo library',
                    onPress: () => void choose('photo'),
                  },
                  { text: 'Choose files', onPress: () => void choose('file') },
                  { text: 'Cancel', style: 'cancel' },
                ])
              }
              style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}
            >
              <Text style={{ color: c.accent }}>＋ Attach</Text>
            </Pressable>
            <Action
              label={send.isPending ? 'Sending…' : 'Send'}
              disabled={
                busy ||
                Boolean(runId) ||
                !selectedModel ||
                (!draft.trim() && !files.length)
              }
              onPress={submit}
            />
          </View>
        </View>
        <Modal
          visible={showModels}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setShowModels(false)}
        >
          <SafeAreaView
            style={[styles.screen, { backgroundColor: c.background }]}
          >
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={[styles.heading, { color: c.text }]}>
                Choose a model
              </Text>
              {config.error ? (
                <Notice
                  title="Couldn’t load models"
                  detail={errorText(config.error)}
                  action={{
                    label: 'Try again',
                    onPress: () => void config.refetch(),
                  }}
                />
              ) : null}
              {!choices.length ? (
                <Text style={[styles.body, { color: c.muted }]}>
                  Configure and enable a provider model in Hatch web to start a
                  conversation.
                </Text>
              ) : null}
              {choices.map((item) => (
                <Action
                  key={`${item.providerId}:${item.modelId}`}
                  secondary
                  label={`${item.providerName} · ${item.name}`}
                  onPress={() => {
                    setModel({
                      providerId: item.providerId,
                      modelId: item.modelId,
                    });
                    setShowModels(false);
                  }}
                />
              ))}
              <Action label="Done" onPress={() => setShowModels(false)} />
            </ScrollView>
          </SafeAreaView>
        </Modal>
      </KeyboardAvoidingView>
    </View>
  );
}
