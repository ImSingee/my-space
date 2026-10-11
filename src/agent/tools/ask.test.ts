import { validateToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createAskTool, type AskBridge } from './ask';

describe('ask optional arguments', () => {
  it('defaults an empty nested flag while retaining explicit false and true', async () => {
    const bridge = vi.fn<AskBridge>().mockResolvedValue([]);
    const tool = createAskTool(bridge);
    for (const allowMultiple of [null, '', [], {}, 0, false, true]) {
      const args = {
        questions: [
          {
            prompt: 'Choose a color',
            options: [{ label: 'Red' }, { label: 'Blue' }],
            allowMultiple,
          },
        ],
      };
      const original = structuredClone(args);
      expect(() =>
        validateToolCall([tool], {
          type: 'toolCall',
          id: 'ask',
          name: tool.name,
          arguments: args,
        }),
      ).not.toThrow();
      await tool.execute('ask', args);
      expect(bridge).toHaveBeenLastCalledWith(
        [
          {
            id: 'q1',
            prompt: 'Choose a color',
            options: [
              { id: 'o1', label: 'Red' },
              { id: 'o2', label: 'Blue' },
            ],
            allowMultiple: allowMultiple === true,
          },
        ],
        undefined,
      );
      expect(args).toEqual(original);
    }
  });
});
