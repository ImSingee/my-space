/** Shared attachment metadata and prompt formatting for Platform and Runner. */

export type AgentAttachmentRef = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

const CONTEXT_OPEN = '<hatch_attachments>';
const CONTEXT_CLOSE = '</hatch_attachments>';
const CONTEXT_INTRO =
  'These files are stored on the Platform and are not in the workspace yet.';
const CONTEXT_INSTRUCTION =
  'Call download_attachment with an id when you need a local copy.';
const MAX_FILENAME_BYTES = 255;
const utf8 = new TextEncoder();

function utf8Length(value: string): number {
  return utf8.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8Length(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function truncateFilename(value: string): string {
  if (utf8Length(value) <= MAX_FILENAME_BYTES) return value;

  const dot = value.lastIndexOf('.');
  if (dot > 0 && dot < value.length - 1) {
    const extension = value.slice(dot);
    const remaining = MAX_FILENAME_BYTES - utf8Length(extension);
    if (remaining > 0) {
      const stem = truncateUtf8(value.slice(0, dot), remaining);
      if (stem) return stem + extension;
    }
  }
  return truncateUtf8(value, MAX_FILENAME_BYTES);
}

export function safeAttachmentName(input: string): string {
  const basename = input.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const normalized = basename
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-');
  const safe = truncateFilename(normalized.replace(/^\.+/, ''));
  return safe && safe !== '.' && safe !== '..' ? safe : 'attachment';
}

export function formatAttachmentPrompt(
  userText: string,
  attachments: AgentAttachmentRef[],
): string {
  const clean = userText.trimEnd();
  if (attachments.length === 0) return clean;
  const context = formatAttachmentContext(attachments);
  return clean ? `${clean}\n\n${context}` : context;
}

function formatAttachmentContext(attachments: AgentAttachmentRef[]): string {
  const rows = attachments.map(
    (attachment) =>
      `- id=${attachment.id} name=${JSON.stringify(attachment.name)} ` +
      `type=${attachment.mimeType} size=${attachment.size}`,
  );
  return [
    CONTEXT_OPEN,
    CONTEXT_INTRO,
    CONTEXT_INSTRUCTION,
    ...rows,
    CONTEXT_CLOSE,
  ].join('\n');
}

export function stripAttachmentPrompt(
  text: string,
  attachments: AgentAttachmentRef[],
): string {
  if (attachments.length === 0) return text;
  const context = formatAttachmentContext(attachments);
  if (text === context) return '';
  const suffix = `\n\n${context}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
