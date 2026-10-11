import type { JSONContent } from '@tiptap/core';
import {
  compactComposerInput,
  type ComposerInputPart,
} from '~agent/composer-content';

/** Build the plain paragraph document used when a chip/example seeds a draft. */
export function plainTextComposerDocument(text: string): JSONContent {
  return composerDocumentFromParts([{ type: 'text', text }]);
}

/** Build an editor document without losing inline snapshots or line breaks. */
export function composerDocumentFromParts(
  parts: ComposerInputPart[],
): JSONContent {
  const paragraphs: JSONContent[] = [{ type: 'paragraph', content: [] }];
  for (const part of parts) {
    if (part.type === 'text') {
      part.text.split('\n').forEach((line, index) => {
        if (index > 0) paragraphs.push({ type: 'paragraph', content: [] });
        if (line)
          paragraphs.at(-1)!.content!.push({ type: 'text', text: line });
      });
    } else {
      paragraphs.at(-1)!.content!.push({
        type: 'mention',
        attrs: {
          id: part.id,
          label: part.name,
          resourceType: part.type,
          ...(part.type === 'app' ? { slug: part.slug } : {}),
        },
      });
    }
  }
  return {
    type: 'doc',
    content: paragraphs,
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
    const resourceType = node.attrs?.resourceType;
    if (typeof id !== 'string' || !id || typeof name !== 'string') return;
    if (resourceType === 'workflow') {
      parts.push({ type: 'workflow', id, name });
      return;
    }
    // Mentions created before resourceType existed are Apps and already carry
    // a slug, so keep them serializable during hot reloads.
    if (typeof slug === 'string' && slug) {
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

/** Convert the editor document into ordered text/resource nodes for the API. */
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
