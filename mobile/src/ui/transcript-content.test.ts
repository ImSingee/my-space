import { describe, expect, it } from 'vitest';
import { messageBlocks } from './transcript-content';

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

describe('stored message blocks', () => {
  it('shows mentions from composer content together with stored photos', () => {
    const blocks = messageBlocks({
      role: 'user',
      content: [{ type: 'text', text: 'Fix @Notes' }, image],
      composerContent: [
        { type: 'text', text: 'Fix ' },
        { type: 'app', id: 'a1', name: 'Notes' },
      ],
    });
    expect(blocks).toEqual([
      { type: 'text', text: 'Fix ' },
      { type: 'app', id: 'a1', name: 'Notes' },
      image,
    ]);
  });

  it('shows plain content as stored when there is no composer content', () => {
    const content = [{ type: 'text', text: 'Hello' }, image];
    expect(messageBlocks({ role: 'user', content })).toEqual(content);
    expect(messageBlocks({ role: 'assistant', content: 'Hi' })).toEqual([
      { type: 'text', text: 'Hi' },
    ]);
  });

  it('falls back to the stored content when composer content is empty', () => {
    const content = [{ type: 'text', text: 'Plain words' }, image];
    expect(
      messageBlocks({ role: 'user', content, composerContent: [] }),
    ).toEqual(content);
  });
});
