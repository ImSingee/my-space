import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
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
    {
      id: 'provider-latest',
      name: 'Latest provider',
      apiType: 'openai-responses',
      baseUrl: 'https://latest.example.test/v1',
      enabled: true,
      sortOrder: 1,
      models: [
        {
          id: 'model-row-2',
          modelId: 'model-latest',
          name: 'Latest model',
          reasoning: false,
          contextWindow: 64_000,
          maxTokens: 4_096,
          input: ['text'],
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

beforeEach(() => {
  fixtures.failSessionFetch = false;
  for (const provider of fixtures.providers) {
    provider.enabled = true;
    for (const model of provider.models) model.enabled = true;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('retries once with the selected model, hides stale error, and allows a same-index failure again', async () => {
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
  await screen.getByRole('button', { name: 'Original model' }).click();
  await screen.getByRole('menuitem', { name: 'Latest model' }).click();
  const latestModelPicker = screen.getByRole('button', {
    name: 'Latest model',
  });
  await expect.element(latestModelPicker).toBeVisible();
  await retry.dblClick();

  await expect.element(retry).toBeDisabled();
  await expect.element(latestModelPicker).toBeDisabled();
  await expect.element(retry).toHaveAttribute('aria-busy', 'true');
  const startCalls = fetchMock.mock.calls.filter(
    ([input]) => String(input) === '/api/agent/runs',
  );
  expect(startCalls).toHaveLength(1);
  expect(JSON.parse(String(startCalls[0][1]?.body))).toEqual({
    sessionId: 'session-1',
    retry: true,
    providerId: 'provider-latest',
    modelId: 'model-latest',
  });

  resolveStart?.();

  await expect.element(retry).not.toBeInTheDocument();
  expect(screen.getByText('Retry exactly').all()).toHaveLength(1);
  await expect
    .element(screen.getByText('Provider unavailable'))
    .not.toBeInTheDocument();
  expect(
    queryClient.getQueryData(['test-agent-session', 'session-1']),
  ).toMatchObject({
    providerId: 'provider-latest',
    modelId: 'model-latest',
  });

  // The retry can fail at the same transcript index. That is a new terminal
  // error, not the stale one the successful retry start just removed.
  queryClient.setQueryData(
    ['test-agent-session', 'session-1'],
    fixtures.session,
  );
  await expect.element(retry).toBeVisible();
});

test('keeps the final error Retry visible but disabled without a model', async () => {
  for (const provider of fixtures.providers) provider.enabled = false;
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    throw new Error(`Unexpected fetch: ${String(input)}`);
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
  await expect.element(retry).toBeDisabled();
  await retry.click({ force: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('sends a new message with the model currently shown in the picker', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === '/api/agent/runs') {
      fixtures.failSessionFetch = true;
      return Response.json({ runId: 'run-send' });
    }
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

  await screen.getByRole('button', { name: 'Original model' }).click();
  await screen.getByRole('menuitem', { name: 'Latest model' }).click();
  await screen.getByPlaceholder('Message the Agent…').fill('Use the new model');
  await screen.getByRole('button', { name: 'Send' }).click();

  await vi.waitFor(() => {
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === '/api/agent/runs',
      ),
    ).toHaveLength(1);
  });
  const startCall = fetchMock.mock.calls.find(
    ([input]) => String(input) === '/api/agent/runs',
  );
  expect(JSON.parse(String(startCall?.[1]?.body))).toEqual({
    sessionId: 'session-1',
    userText: 'Use the new model',
    images: [],
    providerId: 'provider-latest',
    modelId: 'model-latest',
  });
  expect(
    queryClient.getQueryData(['test-agent-session', 'session-1']),
  ).toMatchObject({
    providerId: 'provider-latest',
    modelId: 'model-latest',
  });
});
