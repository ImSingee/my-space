import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { expect, test, vi } from 'vitest';
import { SessionsPanel } from './sessions-panel';

vi.mock('~queries/agent', () => ({
  sessionsQueryOptions: {
    queryKey: ['test-agent-sessions'],
    queryFn: async () => [],
  },
  sessionQueryOptions: (sessionId: string) => ({
    queryKey: ['test-agent-session', sessionId],
    queryFn: async () => null,
  }),
}));

vi.mock('~server/agent-sessions', () => ({
  deleteSession:
    vi.fn<(input: { data: { id: string } }) => Promise<{ ok: boolean }>>(),
  renameSession:
    vi.fn<
      (input: {
        data: { id: string; title: string };
      }) => Promise<{ ok: boolean }>
    >(),
}));

test('defers local-calendar headings until after hydration', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ['test-agent-sessions'],
    [
      {
        id: '01K2A000000000000000000001',
        title: 'Timezone boundary chat',
        appId: null,
        providerId: null,
        modelId: null,
        messageCount: 2,
        updatedAt: '2026-08-16T20:00:00.000Z',
      },
    ],
  );

  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <SessionsPanel
          selected={null}
          onSelect={vi.fn<(id: string | null) => void>()}
        />
      </MantineProvider>
    </QueryClientProvider>,
  );

  expect(html).toContain('Timezone boundary chat');
  expect(html).not.toContain('Today');
  expect(html).not.toContain('Yesterday');
});
