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
import type { ChatMessage, ContentPart } from './types';
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

export function Chat({
  sessionId,
  initialDraft,
}: {
  sessionId: string;
  initialDraft?: ChatDraft;
}) {
  const qc = useQueryClient();
  const sessionQuery = useQuery(sessionQueryOptions(sessionId));
  const { groups, first } = useModelOptions();

  const [model, setModel] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentDraftRef = useRef(false);

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

  // Auto-send the draft message captured by the new-chat hero exactly once,
  // so starting a build from the hero flows straight into a streaming reply.
  useEffect(() => {
    if (!initialDraft || sentDraftRef.current) return;
    sentDraftRef.current = true;
    const value = `${initialDraft.providerId}:${initialDraft.modelId}`;
    setModel(value);
    send(initialDraft.text, initialDraft.images, value);
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
              {allMessages.map((m, i) => (
                <MessageView key={i} message={m} />
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
