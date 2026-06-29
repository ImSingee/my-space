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
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { IconSparkles } from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  providersQueryOptions,
  sessionQueryOptions,
  sessionsQueryOptions,
} from '~queries/agent';
import { Composer, type ComposerImage, type ComposerSubmit } from './composer';
import { ModelPicker } from './model-picker';
import { MessageView, StreamingBubble } from './message-view';
import {
  type AssistantBlock,
  type ChatMessage,
  pairToolResults,
} from './types';
import { useAgentStream } from './use-agent-stream';
import classes from './chat.module.css';

export function useModelOptions() {
  const { data: providers } = useSuspenseQuery(providersQueryOptions);
  return useMemo(() => {
    const groups = providers
      .filter((p) => p.enabled)
      .map((p) => ({
        group: p.name,
        items: p.models
          .filter((m) => m.enabled)
          .map((m) => ({ value: `${p.id}:${m.modelId}`, label: m.name })),
      }))
      .filter((g) => g.items.length > 0);
    const first = groups[0]?.items[0]?.value ?? null;
    return { groups, first };
  }, [providers]);
}

/**
 * Decode a model picker value (`<providerId>:<modelId>`). Provider ids are
 * ULIDs (never contain a colon), but model ids legitimately do — e.g.
 * Bedrock-style ids ending in `:0` — so split only on the first separator and
 * keep the remainder intact instead of `split(':')` which would truncate them.
 */
export function splitModelValue(
  value: string,
): { providerId: string; modelId: string } | null {
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const providerId = value.slice(0, sep);
  const modelId = value.slice(sep + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

type RenderTurn =
  | { kind: 'user'; key: string; message: ChatMessage }
  | { kind: 'assistant'; key: string; blocks: AssistantBlock[] };

/**
 * Collapse one agent reply — which the backend may split across several
 * assistant + tool-result messages — into a single turn. This lets all of a
 * reply's steps render as one evenly-spaced timeline instead of clusters with
 * uneven gaps at each message boundary. Tool-result messages are dropped here
 * because they are merged into their call rows via `pairToolResults`.
 */
function groupTurns(messages: ChatMessage[]): RenderTurn[] {
  const turns: RenderTurn[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      turns.push({ kind: 'user', key: `m${index}`, message });
    } else if (message.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.kind === 'assistant') {
        last.blocks = [...last.blocks, ...message.content];
      } else {
        turns.push({
          kind: 'assistant',
          key: `m${index}`,
          blocks: [...message.content],
        });
      }
    }
  });
  return turns;
}

export function Chat({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const sessionQuery = useQuery(sessionQueryOptions(sessionId));
  const { groups, first } = useModelOptions();

  const [model, setModel] = useState<string | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      setReconnectToken((value) => value + 1);
    }, 750);
  }, [clearReconnectTimer]);

  const revalidateSession = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: sessionQueryOptions(sessionId).queryKey,
    });
    void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
  }, [qc, sessionId]);

  const clearActiveRun = () => {
    clearReconnectTimer();
    qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
      old
        ? {
            ...old,
            activeRun: null,
          }
        : old,
    );
    revalidateSession();
  };

  const stream = useAgentStream(
    (messages, title) => {
      clearReconnectTimer();
      qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
        old
          ? {
              ...old,
              title,
              activeRun: null,
              messages: messages as unknown as typeof old.messages,
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
    },
    clearActiveRun,
    scheduleReconnect,
    revalidateSession,
  );
  const {
    state: streamState,
    send: sendRun,
    connect,
    stop: stopRun,
    answer,
  } = stream;

  const session = sessionQuery.data;
  const effectiveModel =
    model ??
    (session?.providerId && session?.modelId
      ? `${session.providerId}:${session.modelId}`
      : null) ??
    first;

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
  const renderedTurns = useMemo(
    () =>
      turns.map((turn) => (
        <MessageView
          key={turn.key}
          message={
            turn.kind === 'user'
              ? turn.message
              : { role: 'assistant', content: turn.blocks }
          }
          toolResults={toolResults}
        />
      )),
    [turns, toolResults],
  );
  const busy = streamState.active || Boolean(session?.activeRun);

  const send = async (
    text: string,
    images: ComposerImage[],
    modelValue: string,
  ): Promise<boolean> => {
    if (busy) return false;
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
    // Surface the run immediately so the connection effect subscribes without
    // waiting for the session refetch round-trip.
    qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
      old
        ? {
            ...old,
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
  };

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

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length, streamState]);

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
          ) : messages.length === 0 && !streamState.active ? (
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
              {streamState.active ? (
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
              />
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
