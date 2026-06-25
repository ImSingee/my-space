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
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  providersQueryOptions,
  sessionQueryOptions,
  sessionsQueryOptions,
} from '~queries/agent';
import { Composer, type ComposerImage, type ComposerSubmit } from './composer';
import { ModelPicker } from './model-picker';
import { MessageView, StreamingBubble } from './message-view';
import { takeDraft } from './pending-draft';
import {
  type AssistantBlock,
  type ChatMessage,
  type ContentPart,
  pairToolResults,
} from './types';
import { useAgentStream } from './use-agent-stream';
import classes from './chat.module.css';

export type ChatDraft = {
  text: string;
  images: ComposerImage[];
  providerId: string;
  modelId: string;
};

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

function buildParts(text: string, images: ComposerImage[]): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  }
  return parts;
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
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);

  const stream = useAgentStream((messages) => {
    qc.setQueryData(sessionQueryOptions(sessionId).queryKey, (old) =>
      old
        ? { ...old, messages: messages as unknown as typeof old.messages }
        : old,
    );
    setPending([]);
    void qc.invalidateQueries({ queryKey: sessionsQueryOptions.queryKey });
  });

  const session = sessionQuery.data;
  const effectiveModel =
    model ??
    (session?.providerId && session?.modelId
      ? `${session.providerId}:${session.modelId}`
      : null) ??
    first;

  const messages = (session?.messages ?? []) as unknown as ChatMessage[];
  const allMessages = [...messages, ...pending];
  const toolResults = pairToolResults(allMessages);
  const turns = groupTurns(allMessages);

  const send = (text: string, images: ComposerImage[], modelValue: string) => {
    if (stream.state.active) return;
    if (!text && images.length === 0) return;
    const [providerId, modelId] = modelValue.split(':');
    if (!providerId || !modelId) return;

    setPending((p) => [
      ...p,
      { role: 'user', content: buildParts(text, images) },
    ]);
    void stream.send({
      sessionId,
      userText: text,
      images,
      providerId,
      modelId,
    });
  };

  const onComposerSubmit = ({ text, images }: ComposerSubmit) => {
    if (!effectiveModel) return;
    send(text, images, effectiveModel);
  };

  // Auto-send the draft captured by the new-chat hero exactly once, so starting
  // a build from the hero flows straight into a streaming reply. The draft is
  // handed off in memory (keyed by session) and consumed here on mount; this
  // component is keyed by session id, so the effect runs once per chat.
  useEffect(() => {
    const draft = takeDraft(sessionId);
    if (!draft) return;
    const value = `${draft.providerId}:${draft.modelId}`;
    setModel(value);
    send(draft.text, draft.images, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [allMessages.length, stream.state]);

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
          ) : allMessages.length === 0 && !stream.state.active ? (
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
              {stream.state.active ? (
                <StreamingBubble
                  state={stream.state}
                  onAnswer={stream.answer}
                />
              ) : null}
            </>
          )}
        </Box>
      </ScrollArea>

      <Box className={classes.composer}>
        <Box className={classes.composerInner}>
          <Composer
            onSubmit={onComposerSubmit}
            busy={stream.state.active}
            onStop={stream.stop}
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
