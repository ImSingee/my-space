import {
  Box,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSparkles } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { sessionQueryOptions, sessionsQueryOptions } from '~queries/agent';
import { Composer, type ComposerImage, type ComposerSubmit } from './composer';
import {
  getRetryableErrorInput,
  groupTurns,
  hasPersistedAgentError,
} from './chat-turns';
import { MessageView } from './message-view';
import { useModelOptions } from './model-options';
import { ModelPicker } from './model-picker';
import { resolveEffectiveModel, splitModelValue } from './model-value';
import { StreamingBubble } from './streaming-bubble';
import { type ChatMessage, pairToolResults } from './types';
import { useAgentStream } from './use-agent-stream';
import classes from './chat.module.css';

export function Chat({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const sessionQuery = useQuery(sessionQueryOptions(sessionId));
  const { groups, first, available } = useModelOptions();

  const [model, setModel] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [consumedRetryIdentity, setConsumedRetryIdentity] = useState<
    string | null
  >(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const retryingRef = useRef(false);
  const RECONNECT_TOAST_ID = 'agent-reconnect';

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  // Exponential backoff so a server restart / flaky link doesn't hammer the
  // endpoint (and spam toasts) every 750ms. Attempts reset once a connection
  // succeeds (onConnected) or the run ends.
  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    const attempt = reconnectAttemptsRef.current;
    reconnectAttemptsRef.current = attempt + 1;
    const delay = Math.min(15000, 750 * 2 ** attempt);
    // Only surface a toast once the blips look like a real outage, and reuse a
    // stable id so it never stacks.
    if (attempt === 3) {
      toast.error('Reconnecting to the agent…', { id: RECONNECT_TOAST_ID });
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectToken((value) => value + 1);
    }, delay);
  }, [clearReconnectTimer]);

  const onStreamConnected = useCallback(() => {
    if (reconnectAttemptsRef.current > 0) {
      reconnectAttemptsRef.current = 0;
      toast.dismiss(RECONNECT_TOAST_ID);
    }
  }, []);

  const revalidateSession = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: sessionQueryOptions(sessionId).queryKey,
    });
    void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
  }, [qc, sessionId]);

  const clearActiveRun = async (errorMessage?: string): Promise<boolean> => {
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
      old
        ? {
            ...old,
            activeRun: null,
          }
        : old,
    );
    void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });

    // A model/provider failure is already part of the assistant transcript.
    // Wait for that canonical snapshot before removing the live error so the UI
    // never flashes blank. Failures before an assistant message exists (for
    // example dispatch rejection) return false and keep their existing toast.
    const refreshed = await qc.fetchQuery(sessionQueryOptions(sessionId));
    if (!errorMessage) return true;
    const refreshedMessages = (refreshed?.messages ?? []) as ChatMessage[];
    return hasPersistedAgentError(refreshedMessages);
  };

  const stream = useAgentStream(
    () => {
      // `done` no longer ships the transcript; refetch the session to read the
      // messages + title the server just persisted, and drop the active run.
      clearReconnectTimer();
      reconnectAttemptsRef.current = 0;
      qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
        old ? { ...old, activeRun: null } : old,
      );
      revalidateSession();
    },
    clearActiveRun,
    scheduleReconnect,
    revalidateSession,
    onStreamConnected,
  );
  const {
    state: streamState,
    send: sendRun,
    retry: retryRun,
    connect,
    stop: stopRun,
    answer,
  } = stream;

  const session = sessionQuery.data;
  const sessionModel =
    session?.providerId && session?.modelId
      ? `${session.providerId}:${session.modelId}`
      : null;
  const effectiveModel = resolveEffectiveModel(
    model,
    sessionModel,
    available,
    first,
  );
  const effectiveModelParts = useMemo(
    () => (effectiveModel ? splitModelValue(effectiveModel) : null),
    [effectiveModel],
  );

  const messages = useMemo(
    () => (session?.messages ?? []) as unknown as ChatMessage[],
    [session?.messages],
  );
  // Memoize the rendered transcript so a streaming token — which only updates
  // local `streamState` — doesn't re-run every past message's markdown/KaTeX
  // parse. While a run streams, `session.messages` is stable, so `turns`,
  // `toolResults`, and these elements stay referentially identical and React
  // skips re-rendering the whole history; only the live `StreamingBubble` below
  // re-renders per delta. (Re-rendering the entire transcript on every token
  // was pegging the browser's main thread and freezing the UI mid-run.)
  const toolResults = useMemo(() => pairToolResults(messages), [messages]);
  const turns = useMemo(() => groupTurns(messages), [messages]);
  const retryInput = useMemo(
    () => getRetryableErrorInput(messages),
    [messages],
  );
  const retryableTurn = turns.at(-1);
  const retryableTurnKey =
    retryInput &&
    retryableTurn?.kind === 'assistant' &&
    retryableTurn.stopReason === 'error'
      ? retryableTurn.key
      : null;
  const retryIdentity = retryableTurnKey
    ? `${sessionId}:${retryableTurnKey}`
    : null;
  const runBusy = streamState.active || Boolean(session?.activeRun);
  const busy = runBusy || retrying;

  const send = useCallback(
    async (
      text: string,
      images: ComposerImage[],
      modelValue: string,
    ): Promise<boolean> => {
      if (runBusy) return false;
      if (!text && images.length === 0) return false;
      const parsed = splitModelValue(modelValue);
      if (!parsed) return false;

      const runId = await sendRun({
        sessionId,
        userText: text,
        images,
        providerId: parsed.providerId,
        modelId: parsed.modelId,
      });
      if (!runId) return false;
      // A successful start has consumed the currently retryable error even if
      // the new user message cannot be refetched yet (or the run ends before
      // the active state is observed). A normal send appends another turn, so
      // its later error has a different key; atomic Retry uses the separate
      // cache-replacement path below and deliberately does not consume this key.
      if (retryIdentity) setConsumedRetryIdentity(retryIdentity);
      // Surface the run immediately so the connection effect subscribes without
      // waiting for the session refetch round-trip.
      const sessionOptions = sessionQueryOptions(sessionId);
      await qc.cancelQueries({ queryKey: sessionOptions.queryKey });
      qc.setQueryData(sessionOptions.queryKey, (old) =>
        old
          ? {
              ...old,
              providerId: parsed.providerId,
              modelId: parsed.modelId,
              activeRun: {
                id: runId,
                status: 'running' as const,
                pendingAsk: null,
              },
            }
          : old,
      );
      revalidateSession();
      return true;
    },
    [qc, revalidateSession, retryIdentity, runBusy, sendRun, sessionId],
  );

  // Keep the retry action mounted while its POST is pending so MessageView can
  // show a disabled loading button. Other active runs hide it entirely.
  const canOfferRetry = Boolean(
    retryInput &&
    retryIdentity &&
    consumedRetryIdentity !== retryIdentity &&
    (!runBusy || retrying),
  );
  const retry = useCallback(async () => {
    // React state does not update synchronously, so the ref closes the window in
    // which a rapid double click could create two active runs for one session.
    if (retryingRef.current || runBusy || !retryInput || !effectiveModelParts)
      return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      const runId = await retryRun({
        sessionId,
        providerId: effectiveModelParts.providerId,
        modelId: effectiveModelParts.modelId,
      });
      if (!runId) return;
      const sessionOptions = sessionQueryOptions(sessionId);
      // Stop an older background refetch from restoring the failed transcript
      // over the optimistic retry snapshot. A repeated failure may land at the
      // same message index, so unlike a normal send this does not consume the
      // retry identity — that new error must be retryable again.
      await qc.cancelQueries({ queryKey: sessionOptions.queryKey });
      qc.setQueryData(sessionOptions.queryKey, (old) =>
        old
          ? {
              ...old,
              // The server atomically removed this user message and everything
              // after it before starting the run. Keep one local copy so the
              // retried prompt remains visible without the failed reply.
              messages: old.messages.slice(0, retryInput.userMessageIndex + 1),
              providerId: effectiveModelParts.providerId,
              modelId: effectiveModelParts.modelId,
              activeRun: {
                id: runId,
                status: 'running' as const,
                pendingAsk: null,
              },
            }
          : old,
      );
      revalidateSession();
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, [
    effectiveModelParts,
    qc,
    retryInput,
    retryRun,
    revalidateSession,
    runBusy,
    sessionId,
  ]);

  const renderedTurns = useMemo(
    () =>
      turns.map((turn) => {
        const showRetry =
          turn.kind === 'assistant' &&
          turn.key === retryableTurnKey &&
          canOfferRetry;
        return (
          <MessageView
            key={turn.key}
            message={
              turn.kind === 'user'
                ? turn.message
                : {
                    role: 'assistant',
                    content: turn.blocks,
                    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
                    ...(turn.errorMessage
                      ? { errorMessage: turn.errorMessage }
                      : {}),
                  }
            }
            toolResults={toolResults}
            onRetry={showRetry ? retry : undefined}
            retrying={showRetry && retrying}
            retryDisabled={showRetry && !effectiveModelParts}
          />
        );
      }),
    [
      canOfferRetry,
      effectiveModelParts,
      retry,
      retryableTurnKey,
      retrying,
      toolResults,
      turns,
    ],
  );

  // Return acceptance so the composer keeps the draft if the run fails to start
  // (e.g. an oversized payload the server rejects) instead of losing it.
  const onComposerSubmit = ({
    text,
    images,
  }: ComposerSubmit): Promise<boolean> => {
    if (!effectiveModel) return Promise.resolve(false);
    return send(text, images, effectiveModel);
  };

  const stop = () => {
    clearReconnectTimer();
    void stopRun(session?.activeRun?.id).finally(() => {
      revalidateSession();
    });
  };

  // One effect owns the event-stream subscription for the active run: it opens
  // the stream on setup and aborts it on cleanup. Because connect and abort live
  // in the same effect, React's passive-effect teardown/re-run cycle (Suspense
  // hide/show, remounts) re-establishes the stream instead of leaving it
  // canceled — which previously left the chat stuck on "Thinking…".
  useEffect(() => {
    const activeRunId = session?.activeRun?.id ?? null;
    if (!activeRunId) return;
    return connect(activeRunId);
  }, [connect, reconnectToken, session?.activeRun?.id]);

  useEffect(() => clearReconnectTimer, [clearReconnectTimer]);

  // Track whether the viewport is pinned near the bottom. While streaming we
  // only auto-follow when it is, so a user who scrolls up to read earlier
  // output isn't yanked back down on every token.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // A new message (user send / finished turn) always scrolls to the bottom and
  // re-pins follow; this also covers the initial load.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight });
  }, [messages.length]);

  // Streaming tokens follow only when pinned to the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [streamState]);

  return (
    <Box className={classes.chat}>
      <Box className={classes.chatHead}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" color="ember" radius="md" size="md">
            <IconSparkles size={16} stroke={1.7} />
          </ThemeIcon>
          <Text fw={600} truncate>
            {session?.title ?? 'Chat'}
          </Text>
        </Group>
      </Box>

      <ScrollArea className={classes.messages} viewportRef={viewportRef}>
        <Box className={classes.messagesInner}>
          {sessionQuery.isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : messages.length === 0 &&
            !streamState.active &&
            !streamState.terminalError ? (
            <Stack align="center" gap={6} py={80}>
              <ThemeIcon size={48} radius="xl" variant="light" color="ember">
                <IconSparkles size={24} stroke={1.5} />
              </ThemeIcon>
              <Text fw={600}>Describe an app to build</Text>
              <Text size="sm" c="dimmed" ta="center" maw={360}>
                Ask the Agent to create a tracker, a notes app, a dashboard —
                anything. It will scaffold, build, and deploy it for you.
              </Text>
            </Stack>
          ) : (
            <>
              {renderedTurns}
              {streamState.active || streamState.terminalError ? (
                <StreamingBubble state={streamState} onAnswer={answer} />
              ) : null}
            </>
          )}
        </Box>
      </ScrollArea>

      <Box className={classes.composer}>
        <Box className={classes.composerInner}>
          <Composer
            onSubmit={onComposerSubmit}
            busy={busy}
            onStop={stop}
            disabled={!effectiveModel}
            modelControl={
              <ModelPicker
                groups={groups}
                value={effectiveModel}
                onChange={setModel}
                disabled={busy}
              />
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
