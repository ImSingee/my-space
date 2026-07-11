import { beforeEach, describe, expect, it, vi } from 'vitest';

const createSession = vi.hoisted(() =>
  vi.fn<(input: { data: Record<string, never> }) => Promise<{ id: string }>>(
    async () => ({ id: 'new-session' }),
  ),
);

vi.mock('~server/agent-sessions', () => ({ createSession }));

import { createEmptyAgentSession } from './new-chat-api';

describe('createEmptyAgentSession', () => {
  beforeEach(() => createSession.mockClear());

  it('does not persist a model before the first run is accepted', async () => {
    await expect(createEmptyAgentSession()).resolves.toEqual({
      id: 'new-session',
    });
    expect(createSession).toHaveBeenCalledWith({ data: {} });
  });
});
