import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Chat } from './chat';

const fixtures = vi.hoisted(() => ({
  failSessionFetch: false,
  session: {
    id: 'session-1',
    title: 'Failed request',
    appId: null,
    providerId: 'provider-original',
    modelId: 'model:with-colon',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Retry exactly' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ],
    activeRun: null as null | {
      id: string;
      status: 'running';
      pendingAsk: null;
    },
  },
  providers: [
    {
      id: 'provider-original',
      name: 'Original provider',
      apiType: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      sortOrder: 0,
      models: [
        {
          id: 'model-row-1',
          modelId: 'model:with-colon',
          name: 'Original model',
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 8_192,
          input: ['text', 'image'],
          enabled: true,
          sortOrder: 0,
        },
      ],
    },
  ],
}));

vi.mock('~queries/agent', () => ({
  providersQueryOptions: {
    queryKey: ['test-agent-providers'],
    queryFn: async () => fixtures.providers,
  },
  sessionsQueryOptions: {
    queryKey: ['test-agent-sessions'],
    queryFn: async () => [],
  },
  sessionQueryOptions: (sessionId: string) => ({
    queryKey: ['test-agent-session', sessionId],
    queryFn: async () => {
      if (fixtures.failSessionFetch) {
        throw new Error('Session refetch failed');
      }
      return fixtures.session;
    },
  }),
}));

function doneResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({ seq: 1, event: { type: 'done' } })}\n\n`,
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('retries once, hides stale error, and allows a same-index failure again', async () => {
  let resolveStart: (() => void) | undefined;
  const startResponse = new Promise<Response>((resolve) => {
    resolveStart = () => {
      // Simulate the worst race: the new run finishes immediately while every
      // session refetch fails, leaving the cached transcript on the old error.
      fixtures.failSessionFetch = true;
      resolve(Response.json({ runId: 'run-retry' }));
    };
  });
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === '/api/agent/runs') return startResponse;
    if (url.includes('/events')) return doneResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Chat sessionId="session-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );

  const retry = screen.getByRole('button', { name: 'Retry' });
  await expect.element(retry).toBeVisible();
  await retry.dblClick();

  await expect.element(retry).toBeDisabled();
  await expect.element(retry).toHaveAttribute('aria-busy', 'true');
  const startCalls = fetchMock.mock.calls.filter(
    ([input]) => String(input) === '/api/agent/runs',
  );
  expect(startCalls).toHaveLength(1);
  expect(JSON.parse(String(startCalls[0][1]?.body))).toEqual({
    sessionId: 'session-1',
    retry: true,
  });

  resolveStart?.();

  await expect.element(retry).not.toBeInTheDocument();
  expect(screen.getByText('Retry exactly').all()).toHaveLength(1);
  await expect
    .element(screen.getByText('Provider unavailable'))
    .not.toBeInTheDocument();

  // The retry can fail at the same transcript index. That is a new terminal
  // error, not the stale one the successful retry start just removed.
  queryClient.setQueryData(
    ['test-agent-session', 'session-1'],
    fixtures.session,
  );
  await expect.element(retry).toBeVisible();
});
