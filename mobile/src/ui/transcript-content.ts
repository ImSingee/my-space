import type { JsonValue } from '../core';

function record(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * The blocks a stored message shows. A user message that mentions an App or
 * Workflow keeps its text in `composerContent`, while its photos stay in
 * `content`; both are shown.
 */
export function messageBlocks(message: Record<string, JsonValue>) {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: message.content ?? null }];
  if (message.role !== 'user' || !Array.isArray(message.composerContent))
    return content;
  return [
    ...message.composerContent,
    ...content.filter((part) => record(part)?.type === 'image'),
  ];
}
