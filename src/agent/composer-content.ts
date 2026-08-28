/** Shared Agent Composer content shapes and their model/display serializers. */
import { z } from 'zod';

export const MAX_COMPOSER_PARTS = 128;
export const MAX_COMPOSER_APP_PARTS = 32;
export const MAX_COMPOSER_TEXT_LENGTH = 100_000;

/** App identity snapshot captured when the mention is selected. */
export type ComposerInputPart =
  | { type: 'text'; text: string }
  | { type: 'app'; id: string; name: string; slug: string };

export type AgentComposerContentPart =
  | { type: 'text'; text: string }
  | { type: 'app'; id: string; name: string; slug: string };

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
]);

export const composerInputSchema = z
  .array(composerInputPartSchema)
  .max(MAX_COMPOSER_PARTS)
  .superRefine((parts, context) => {
    const appCount = parts.filter((part) => part.type === 'app').length;
    if (appCount > MAX_COMPOSER_APP_PARTS) {
      context.addIssue({
        code: 'custom',
        message: `Message supports at most ${MAX_COMPOSER_APP_PARTS} App references.`,
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
    ]),
  )
  .max(MAX_COMPOSER_PARTS);

/** Merge adjacent text and discard empty text without moving App references. */
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

/** Visible Composer/transcript text. App identity remains a compact @ token. */
export function composerDisplayText(parts: AgentComposerContentPart[]): string {
  return parts
    .map((part) => (part.type === 'text' ? part.text : `@${part.name}`))
    .join('');
}

/** Exact inline text given to the model for the current user turn. */
export function composerModelText(parts: AgentComposerContentPart[]): string {
  return parts
    .map((part) =>
      part.type === 'text'
        ? part.text
        : `@APP{name=${JSON.stringify(part.name)} id=${JSON.stringify(part.id)} slug=${JSON.stringify(part.slug)}}`,
    )
    .join('');
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
