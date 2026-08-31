/** Shared Agent Composer content shapes and their model/display serializers. */
import { z } from 'zod';

export const MAX_COMPOSER_PARTS = 128;
export const MAX_COMPOSER_REFERENCE_PARTS = 32;
export const MAX_COMPOSER_TEXT_LENGTH = 100_000;

/** Resource identity snapshots captured when a mention is selected. */
export type ComposerInputPart =
  | { type: 'text'; text: string }
  | { type: 'app'; id: string; name: string; slug: string }
  | { type: 'workflow'; id: string; name: string };

export type AgentComposerContentPart =
  | { type: 'text'; text: string }
  | { type: 'app'; id: string; name: string; slug: string }
  | { type: 'workflow'; id: string; name: string };

const composerInputPartSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string().max(MAX_COMPOSER_TEXT_LENGTH),
  }),
  z.strictObject({
    type: z.literal('app'),
    id: z.string().min(1).max(200),
    name: z.string().max(500),
    slug: z.string().min(1).max(200),
  }),
  z.strictObject({
    type: z.literal('workflow'),
    id: z.string().min(1).max(200),
    name: z.string().max(500),
  }),
]);

export const composerInputSchema = z
  .array(composerInputPartSchema)
  .max(MAX_COMPOSER_PARTS)
  .superRefine((parts, context) => {
    const referenceCount = parts.filter((part) => part.type !== 'text').length;
    if (referenceCount > MAX_COMPOSER_REFERENCE_PARTS) {
      context.addIssue({
        code: 'custom',
        message:
          `Message supports at most ${MAX_COMPOSER_REFERENCE_PARTS} ` +
          'resource references.',
      });
    }
    const textLength = parts.reduce(
      (length, part) =>
        part.type === 'text' ? length + part.text.length : length,
      0,
    );
    if (textLength > MAX_COMPOSER_TEXT_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `Message text supports at most ${MAX_COMPOSER_TEXT_LENGTH} characters.`,
      });
    }
  });

export const agentComposerContentSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('text'),
        text: z.string().max(MAX_COMPOSER_TEXT_LENGTH),
      }),
      z.strictObject({
        type: z.literal('app'),
        id: z.string().min(1).max(200),
        name: z.string().max(500),
        slug: z.string().min(1).max(200),
      }),
      z.strictObject({
        type: z.literal('workflow'),
        id: z.string().min(1).max(200),
        name: z.string().max(500),
      }),
    ]),
  )
  .max(MAX_COMPOSER_PARTS);

/** Merge adjacent text and discard empty text without moving references. */
export function compactComposerInput(
  parts: ComposerInputPart[],
): ComposerInputPart[] {
  const compact: ComposerInputPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (!part.text) continue;
      const previous = compact.at(-1);
      if (previous?.type === 'text') previous.text += part.text;
      else compact.push({ ...part });
    } else {
      compact.push({ ...part });
    }
  }
  return compact;
}

/** Visible Composer/transcript text. Resource identity stays a compact @ token. */
export function composerDisplayText(parts: AgentComposerContentPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : `@${part.name}`))
    .join('');
}

/** Exact inline text given to the model for the current user turn. */
export function composerModelText(parts: AgentComposerContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'app') {
        return `@APP{name=${JSON.stringify(part.name)} id=${JSON.stringify(part.id)} slug=${JSON.stringify(part.slug)}}`;
      }
      return `@WORKFLOW{name=${JSON.stringify(part.name)} id=${JSON.stringify(part.id)}}`;
    })
    .join('');
}

export function hasComposerReference(
  parts: AgentComposerContentPart[],
): boolean {
  return parts.some((part) => part.type !== 'text');
}

export function hasComposerText(parts: ComposerInputPart[]): boolean {
  return parts.some(
    (part) => part.type === 'text' && part.text.trim().length > 0,
  );
}

/** Parse optional metadata from a persisted transcript without trusting it. */
export function parseAgentComposerContent(
  value: unknown,
): AgentComposerContentPart[] | undefined {
  const parsed = agentComposerContentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
