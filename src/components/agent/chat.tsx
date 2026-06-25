import {
  ActionIcon,
  Box,
  Center,
  Group,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconArrowUp,
  IconPlayerStopFilled,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  providersQueryOptions,
  sessionQueryOptions,
  sessionsQueryOptions,
} from '~queries/agent';
import { MessageView, StreamingBubble } from './message-view';
import type { ChatMessage } from './types';
import { useAgentStream } from './use-agent-stream';
import classes from './chat.module.css';

function useModelOptions() {
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

export function Chat({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const sessionQuery = useQuery(sessionQueryOptions(sessionId));
  const { groups, first } = useModelOptions();

  const [model, setModel] = useState<string | null>(null);
  const [input, setInput] = useState('');
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

  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [allMessages.length, stream.state]);

  const submit = () => {
    const text = input.trim();
    if (!text || stream.state.active) return;
    const [providerId, modelId] = (effectiveModel ?? '').split(':');
    if (!providerId || !modelId) return;
    setInput('');
    setPending((p) => [...p, { role: 'user', content: text }]);
    void stream.send({ sessionId, userText: text, providerId, modelId });
  };

  return (
    <Box className={classes.chat}>
      <Box className={classes.chatHead}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon variant="light" color="violet" radius="md" size="md">
            <IconSparkles size={16} stroke={1.7} />
          </ThemeIcon>
          <Text fw={600} truncate>
            {session?.title ?? 'Chat'}
          </Text>
        </Group>
        <Select
          data={groups}
          value={effectiveModel}
          onChange={setModel}
          placeholder="Select model"
          size="xs"
          w={200}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
      </Box>

      <ScrollArea className={classes.messages} viewportRef={viewportRef}>
        <Box className={classes.messagesInner}>
          {sessionQuery.isLoading ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : allMessages.length === 0 && !stream.state.active ? (
            <Stack align="center" gap={6} py={80}>
              <ThemeIcon size={48} radius="xl" variant="light" color="violet">
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
                <StreamingBubble state={stream.state} />
              ) : null}
            </>
          )}
        </Box>
      </ScrollArea>

      <Box className={classes.composer}>
        <Box className={classes.composerInner}>
          <Textarea
            placeholder="Message the Agent…  (Enter to send, Shift+Enter for newline)"
            autosize
            minRows={1}
            maxRows={8}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rightSection={
              stream.state.active ? (
                <ActionIcon
                  variant="filled"
                  color="red"
                  radius="xl"
                  aria-label="Stop"
                  onClick={stream.stop}
                >
                  <IconPlayerStopFilled size={16} />
                </ActionIcon>
              ) : (
                <ActionIcon
                  variant="filled"
                  color="violet"
                  radius="xl"
                  aria-label="Send"
                  disabled={!input.trim() || !effectiveModel}
                  onClick={submit}
                >
                  <IconArrowUp size={16} />
                </ActionIcon>
              )
            }
          />
        </Box>
      </Box>
    </Box>
  );
}
