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
  const connectedRunRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearReconnectTimer = useCallback(() => {
    if (!reconnectTimerRef.current) return;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const scheduleReconnect = useCallback(
    (runId: string) => {
      if (connectedRunRef.current === runId) {
        connectedRunRef.current = null;
      }
      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectToken((value) => value + 1);
      }, 750);
    },
    [clearReconnectTimer],
  );

  const revalidateSession = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: sessionQueryOptions(sessionId).queryKey,
    });
    void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
  }, [qc, sessionId]);

  const clearActiveRun = () => {
    clearReconnectTimer();
    connectedRunRef.current = null;
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
      connectedRunRef.current = null;
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

  const messages = (session?.messages ?? []) as unknown as ChatMessage[];
  const allMessages = messages;
  const toolResults = pairToolResults(allMessages);
  const turns = groupTurns(allMessages);
  const busy = streamState.active || Boolean(session?.activeRun);

  const send = (text: string, images: ComposerImage[], modelValue: string) => {
    if (busy) return;
    if (!text && images.length === 0) return;
    const [providerId, modelId] = modelValue.split(':');
    if (!providerId || !modelId) return;

    void sendRun({
      sessionId,
      userText: text,
      images,
      providerId,
      modelId,
    }).then((runId) => {
      if (!runId) return;
      connectedRunRef.current = runId;
      revalidateSession();
    });
  };

  const onComposerSubmit = ({ text, images }: ComposerSubmit) => {
    if (!effectiveModel) return;
    send(text, images, effectiveModel);
  };

  const stop = () => {
    clearReconnectTimer();
    void stopRun(session?.activeRun?.id).finally(() => {
      connectedRunRef.current = null;
      revalidateSession();
    });
  };

  useEffect(() => {
    const activeRunId = session?.activeRun?.id ?? null;
    if (!activeRunId) {
      connectedRunRef.current = null;
      return;
    }
    if (connectedRunRef.current === activeRunId) return;
    connectedRunRef.current = activeRunId;
    void connect(activeRunId);
  }, [connect, reconnectToken, session?.activeRun?.id]);

  useEffect(() => clearReconnectTimer, [clearReconnectTimer]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [allMessages.length, streamState]);

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
          ) : allMessages.length === 0 && !streamState.active ? (
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
              {turns.map((turn) => (
                <MessageView
                  key={turn.key}
                  message={
                    turn.kind === 'user'
                      ? turn.message
                      : { role: 'assistant', content: turn.blocks }
                  }
                  toolResults={toolResults}
                />
              ))}
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
