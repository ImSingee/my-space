import { describe, expect, test } from 'vitest';
import {
  plainTextComposerDocument,
  serializeComposerDocument,
} from './composer-editor-content';

describe('serializeComposerDocument', () => {
  test('preserves inline App order and repeated references', () => {
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
                  slug: 'notes',
                },
              },
              { type: 'text', text: ' with ' },
              {
                type: 'mention',
                attrs: {
                  id: 'app-1',
                  label: 'Notes',
                  slug: 'notes',
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
      { type: 'app', id: 'app-1', name: 'Notes', slug: 'notes' },
      { type: 'text', text: '.' },
    ]);
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
