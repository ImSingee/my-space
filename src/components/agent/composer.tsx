import {
  ActionIcon,
  Box,
  CloseButton,
  Group,
  Image,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowUp,
  IconPaperclip,
  IconPlayerStopFilled,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import classes from './chat.module.css';

export type ComposerImage = { data: string; mimeType: string };
export type ComposerSubmit = { text: string; images: ComposerImage[] };

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

/**
 * The message input shared by the new-chat hero and an active chat. Owns its
 * own draft text and image attachments; emits a normalized payload on submit
 * and clears itself, so the parent only wires up sending.
 */
export function Composer({
  onSubmit,
  busy = false,
  onStop,
  disabled = false,
  focusOnMount = false,
  placeholder = 'Message the Agent…',
  seedText,
  seedNonce,
  modelControl,
}: {
  onSubmit: (payload: ComposerSubmit) => void;
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  focusOnMount?: boolean;
  placeholder?: string;
  /** Prefill the input; re-applied whenever seedNonce changes (e.g. chips). */
  seedText?: string;
  seedNonce?: number;
  /** Control rendered in the action bar, left of Send (e.g. ModelPicker). */
  modelControl?: ReactNode;
}) {
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusOnMount) textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (seedNonce === undefined) return;
    setInput(seedText ?? '');
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const len = (seedText ?? '').length;
      requestAnimationFrame(() => el.setSelectionRange(len, len));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

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

  const canSend =
    (input.trim().length > 0 || attachments.length > 0) && !disabled;

  const submit = () => {
    if (busy) return;
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const images = attachments.map((a) => ({
      data: a.base64,
      mimeType: a.mimeType,
    }));
    onSubmit({ text, images });
    setInput('');
    setAttachments([]);
  };

  return (
    <Box
      className={classes.composerCard}
      data-disabled={disabled || undefined}
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {attachments.length > 0 ? (
        <Group gap="xs" className={classes.attachRow}>
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
        ref={textareaRef}
        variant="unstyled"
        placeholder={placeholder}
        autosize
        minRows={1}
        maxRows={10}
        value={input}
        classNames={{ input: classes.composerInput }}
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
          // `isComposing` guards IME users (CJK): the Enter that commits a
          // candidate must not also submit the prompt mid-composition.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <Group
        className={classes.composerBar}
        justify="space-between"
        wrap="nowrap"
      >
        <Group gap={4} wrap="nowrap">
          <Tooltip label="Attach image" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              radius="xl"
              size="lg"
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPaperclip size={18} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        </Group>

        <Group gap="xs" wrap="nowrap">
          {modelControl}
          {busy ? (
            <Tooltip label="Stop" withArrow>
              <ActionIcon
                variant="filled"
                color="red"
                radius="xl"
                size="lg"
                aria-label="Stop"
                onClick={onStop}
              >
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <ActionIcon
              variant="filled"
              color="ember"
              radius="xl"
              size="lg"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
            >
              <IconArrowUp size={18} stroke={2} />
            </ActionIcon>
          )}
        </Group>
      </Group>
    </Box>
  );
}
