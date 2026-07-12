import {
  ActionIcon,
  Box,
  CloseButton,
  Group,
  Image,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowUp,
  IconFile,
  IconPaperclip,
  IconPlayerStopFilled,
} from '@tabler/icons-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import classes from './chat.module.css';

export type ComposerImage = { data: string; mimeType: string };
export type ComposerFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  file: File;
};
export type ComposerSubmit = {
  text: string;
  images: ComposerImage[];
  files: ComposerFile[];
};

type ImageAttachment = {
  kind: 'image';
  id: string;
  name: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
};

type FileAttachment = ComposerFile & { kind: 'file' };
type Attachment = ImageAttachment | FileAttachment;

const MAX_DIM = 1280;
const MAX_ATTACHMENTS = 6;
// Accepted upload image types. Kept in sync with the server allowlist in
// src/routes/api/agent/runs.ts so a file the UI accepts here is never rejected
// with a 400 after the draft + attachments have already been cleared on submit.
const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];
const ACCEPTED_IMAGE_SET = new Set<string>(ACCEPTED_IMAGE_TYPES);

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
    kind: 'image',
    id: crypto.randomUUID(),
    name: file.name,
    mimeType,
    base64: dataUrl.split(',')[1] ?? '',
    dataUrl,
  };
}

function readFileAttachment(file: File): FileAttachment {
  return {
    kind: 'file',
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    file,
  };
}

/**
 * The message input shared by the new-chat hero and an active chat. Owns its
 * own draft text and attachments; emits a normalized payload on submit
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
  /**
   * Send the draft. Return `false` (or reject) to keep the draft intact — e.g.
   * the server rejected an oversized/invalid payload — so the user never loses
   * their typed text and attachments. Returning void/true clears the composer.
   */
  onSubmit: (
    payload: ComposerSubmit,
  ) => void | boolean | Promise<void | boolean>;
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
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
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
    const all = Array.from(files);
    const nonEmpty = all.filter((file) => file.size > 0);
    if (nonEmpty.length !== all.length) {
      toast.error('Empty files cannot be attached.');
    }
    if (nonEmpty.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }
    try {
      const read = await Promise.all(
        nonEmpty
          .slice(0, room)
          .map((file) =>
            ACCEPTED_IMAGE_SET.has(file.type)
              ? readImageFile(file)
              : Promise.resolve(readFileAttachment(file)),
          ),
      );
      setAttachments((p) => [...p, ...read]);
    } catch {
      toast.error('Could not read that file.');
    }
  };

  const removeAttachment = (id: string) =>
    setAttachments((p) => p.filter((a) => a.id !== id));

  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    !disabled &&
    !submitting;

  const submit = async () => {
    if (busy || disabled || submittingRef.current) return;
    // Snapshot exactly what we send so we can clear only this draft later.
    const submittedInput = input;
    const submittedAttachments = attachments;
    const text = submittedInput.trim();
    if (!text && submittedAttachments.length === 0) return;
    const images = submittedAttachments
      .filter(
        (attachment): attachment is ImageAttachment =>
          attachment.kind === 'image',
      )
      .map((attachment) => ({
        data: attachment.base64,
        mimeType: attachment.mimeType,
      }));
    const files = submittedAttachments
      .filter(
        (attachment): attachment is FileAttachment =>
          attachment.kind === 'file',
      )
      .map(({ kind: _kind, ...attachment }) => attachment);
    // Clear only once the send is accepted: if onSubmit returns false or throws
    // (server rejected the payload, network error, etc.) the draft stays so the
    // user can fix and retry instead of silently losing their message.
    let accepted = true;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      accepted = (await onSubmit({ text, images, files })) !== false;
    } catch {
      accepted = false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (accepted) {
      // Preserve edits made while the send was in flight, but always remove
      // the submitted attachment ids: server-managed files are one-use and
      // would return 409 if a changed draft accidentally submitted them again.
      const submittedIds = new Set(
        submittedAttachments.map((attachment) => attachment.id),
      );
      setInput((current) => (current === submittedInput ? '' : current));
      setAttachments((current) =>
        current.filter((attachment) => !submittedIds.has(attachment.id)),
      );
    }
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
            <Box
              key={a.id}
              className={
                a.kind === 'image' ? classes.thumb : classes.fileAttachment
              }
            >
              {a.kind === 'image' ? (
                <Image
                  src={a.dataUrl}
                  alt={a.name}
                  className={classes.thumbImg}
                />
              ) : (
                <>
                  <IconFile size={18} stroke={1.7} />
                  <Text
                    size="xs"
                    truncate
                    className={classes.fileAttachmentName}
                  >
                    {a.name}
                  </Text>
                </>
              )}
              <CloseButton
                size="xs"
                radius="xl"
                variant={a.kind === 'image' ? 'filled' : 'subtle'}
                className={
                  a.kind === 'image'
                    ? classes.thumbRemove
                    : classes.fileAttachmentRemove
                }
                aria-label={`Remove ${a.name}`}
                onClick={() => removeAttachment(a.id)}
              />
            </Box>
          ))}
        </Group>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
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
          const files = Array.from(e.clipboardData.files);
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
            void submit();
          }
        }}
      />

      <Group
        className={classes.composerBar}
        justify="space-between"
        wrap="nowrap"
      >
        <Group gap={4} wrap="nowrap">
          <Tooltip label="Attach files" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              radius="xl"
              size="lg"
              aria-label="Attach files"
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
              onClick={() => void submit()}
            >
              <IconArrowUp size={18} stroke={2} />
            </ActionIcon>
          )}
        </Group>
      </Group>
    </Box>
  );
}
