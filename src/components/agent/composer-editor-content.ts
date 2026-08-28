import type { JSONContent } from '@tiptap/core';
import {
  compactComposerInput,
  type ComposerInputPart,
} from '~agent/composer-content';

/** Build the plain paragraph document used when a chip/example seeds a draft. */
export function plainTextComposerDocument(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

function serializeInlineNode(
  node: JSONContent,
  parts: ComposerInputPart[],
): void {
  if (node.type === 'text') {
    if (node.text) parts.push({ type: 'text', text: node.text });
    return;
  }
  if (node.type === 'mention') {
    const id = node.attrs?.id;
    const name = node.attrs?.label;
    const slug = node.attrs?.slug;
    if (
      typeof id === 'string' &&
      id &&
      typeof name === 'string' &&
      typeof slug === 'string' &&
      slug
    ) {
      parts.push({ type: 'app', id, name, slug });
    }
    return;
  }
  if (node.type === 'hardBreak') {
    parts.push({ type: 'text', text: '\n' });
    return;
  }

  for (const child of node.content ?? []) {
    serializeInlineNode(child, parts);
  }
}

/** Convert the editor document into ordered text/App nodes for the API. */
export function serializeComposerDocument(
  document: JSONContent,
): ComposerInputPart[] {
  const parts: ComposerInputPart[] = [];
  const blocks = document.content ?? [];
  blocks.forEach((block, index) => {
    if (index > 0) parts.push({ type: 'text', text: '\n' });
    serializeInlineNode(block, parts);
  });
  return compactComposerInput(parts);
}
