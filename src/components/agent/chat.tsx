import {
  ActionIcon,
  Box,
  Center,
  CloseButton,
  Group,
  Image,
  Loader,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconArrowUp,
  IconPhoto,
  IconPlayerStopFilled,
  IconSparkles,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  providersQueryOptions,
  sessionQueryOptions,
  sessionsQueryOptions,
} from '~queries/agent';
import { MessageView, StreamingBubble } from './message-view';
import type { ChatMessage, ContentPart } from './types';
import { useAgentStream } from './use-agent-stream';
import classes from './chat.module.css';

type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
};

const MAX_DIM = 1280;
const MAX_ATTACHMENTS = 6;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = src;
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

/** Read an image file, downscaling large images to keep the payload small. */
async function readImageFile(file: File): Promise<Attachment> {
  const original = await readDataUrl(file);
  const img = await loadImage(original);
  const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));

  let mimeType = file.type || 'image/png';
  let dataUrl = original;
  if (scale < 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      mimeType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      dataUrl = canvas.toDataURL(mimeType, 0.9);
    }
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType,
    base64: dataUrl.split(',')[1] ?? '',
    dataUrl,
  };
}

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(`You can attach up to ${MAX_ATTACHMENTS} images.`);
      return;
    }
    try {
      const read = await Promise.all(images.slice(0, room).map(readImageFile));
      setAttachments((p) => [...p, ...read]);
    } catch {
      toast.error('Could not read that image.');
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((p) => p.filter((a) => a.id !== id));

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
    if (stream.state.active) return;
    if (!text && attachments.length === 0) return;
    const [providerId, modelId] = (effectiveModel ?? '').split(':');
    if (!providerId || !modelId) return;

    const images = attachments.map((a) => ({
      data: a.base64,
      mimeType: a.mimeType,
    }));
    const parts: ContentPart[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const a of attachments) {
      parts.push({ type: 'image', data: a.base64, mimeType: a.mimeType });
    }

    setInput('');
    setAttachments([]);
    setPending((p) => [...p, { role: 'user', content: parts }]);
    void stream.send({
      sessionId,
      userText: text,
      images,
      providerId,
      modelId,
    });
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
          {attachments.length > 0 ? (
            <Group gap="xs">
              {attachments.map((a) => (
                <Box key={a.id} className={classes.thumb}>
                  <Image
                    src={a.dataUrl}
                    alt={a.name}
                    className={classes.thumbImg}
                  />
                  <CloseButton
                    size="xs"
                    radius="xl"
                    variant="filled"
                    className={classes.thumbRemove}
                    aria-label="Remove image"
                    onClick={() => removeAttachment(a.id)}
                  />
                </Box>
              ))}
            </Group>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void addFiles(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <Textarea
            placeholder="Message the Agent…  (Enter to send, Shift+Enter for newline)"
            autosize
            minRows={1}
            maxRows={8}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files).filter((f) =>
                f.type.startsWith('image/'),
              );
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            leftSectionPointerEvents="all"
            leftSection={
              <Tooltip label="Attach image" withArrow>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  radius="xl"
                  aria-label="Attach image"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconPhoto size={18} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
            }
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
                  disabled={
                    (!input.trim() && attachments.length === 0) ||
                    !effectiveModel
                  }
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
