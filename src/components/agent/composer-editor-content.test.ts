import { describe, expect, test } from 'vitest';
import {
  plainTextComposerDocument,
  serializeComposerDocument,
} from './composer-editor-content';

describe('serializeComposerDocument', () => {
  test('preserves inline resource order and repeated references', () => {
    expect(
      serializeComposerDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Compare ' },
              {
                type: 'mention',
                attrs: {
                  id: 'app-1',
                  label: 'Notes',
                  resourceType: 'app',
                  slug: 'notes',
                },
              },
              { type: 'text', text: ' with ' },
              {
                type: 'mention',
                attrs: {
                  id: 'workflow-1',
                  label: 'Nightly Digest',
                  resourceType: 'workflow',
                },
              },
              { type: 'text', text: ' and ' },
              {
                type: 'mention',
                attrs: {
                  id: 'workflow-1',
                  label: 'Nightly Digest',
                  resourceType: 'workflow',
                },
              },
              { type: 'text', text: '.' },
            ],
          },
        ],
      }),
    ).toEqual([
      { type: 'text', text: 'Compare ' },
      { type: 'app', id: 'app-1', name: 'Notes', slug: 'notes' },
      { type: 'text', text: ' with ' },
      { type: 'workflow', id: 'workflow-1', name: 'Nightly Digest' },
      { type: 'text', text: ' and ' },
      { type: 'workflow', id: 'workflow-1', name: 'Nightly Digest' },
      { type: 'text', text: '.' },
    ]);
  });

  test('keeps legacy App mentions without a resource type', () => {
    expect(
      serializeComposerDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'mention',
                attrs: { id: 'app-1', label: 'Notes', slug: 'notes' },
              },
            ],
          },
        ],
      }),
    ).toEqual([{ type: 'app', id: 'app-1', name: 'Notes', slug: 'notes' }]);
  });

  test('preserves paragraph and hard-break newlines', () => {
    expect(
      serializeComposerDocument({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'one' },
              { type: 'hardBreak' },
              { type: 'text', text: 'two' },
            ],
          },
          { type: 'paragraph' },
        ],
      }),
    ).toEqual([{ type: 'text', text: 'one\ntwo\n' }]);
  });
});

describe('plainTextComposerDocument', () => {
  test('round-trips seeded multiline text', () => {
    const text = 'first\n\nlast\n';
    expect(serializeComposerDocument(plainTextComposerDocument(text))).toEqual([
      { type: 'text', text },
    ]);
  });
});
