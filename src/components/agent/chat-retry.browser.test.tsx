import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Chat } from './chat';
import { LAST_SELECTED_MODEL_STORAGE_KEY } from './model-preference';

const fixtures = vi.hoisted(() => ({
  failSessionFetch: false,
  sessionFetchCount: 0,
  session: {
    id: 'session-1',
    title: 'Failed request',
    appIds: [],
    providerId: 'provider-original',
    modelId: 'model:with-colon',
    updatedAt: '2026-07-11T12:00:00.000Z',
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
      pendingEnvRequest: null | {
        requestId: string;
        reason: string;
        variables: { key: string; description: string; secret: boolean }[];
      };
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
      fixtures.sessionFetchCount += 1;
      if (fixtures.failSessionFetch) {
        throw new Error('Session refetch failed');
      }
      return structuredClone(fixtures.session);
    },
  }),
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: {
    queryKey: ['test-apps'],
    queryFn: async () => [],
  },
}));

function doneResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({ seq: 1, event: { type: 'done' } })}\n\n`,
    { status: 200 },
  );
}

function openResponse(signal?: AbortSignal | null): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.close(), {
          once: true,
        });
      },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  localStorage.removeItem(LAST_SELECTED_MODEL_STORAGE_KEY);
  fixtures.failSessionFetch = false;
  fixtures.sessionFetchCount = 0;
  fixtures.session.updatedAt = '2026-07-11T12:00:00.000Z';
  fixtures.session.activeRun = null;
  for (const provider of fixtures.providers) {
    provider.enabled = true;
    for (const model of provider.models) model.enabled = true;
  }
});

afterEach(() => {
  localStorage.removeItem(LAST_SELECTED_MODEL_STORAGE_KEY);
  vi.unstubAllGlobals();
});

test('keeps the conversation model when another model was selected elsewhere', async () => {
  localStorage.setItem(
    LAST_SELECTED_MODEL_STORAGE_KEY,
    JSON.stringify('provider-latest:model-latest'),
  );
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

  await expect
    .element(screen.getByRole('button', { name: 'Original model' }))
    .toBeVisible();
});

test('hydrates a pending env request from the active session run', async () => {
  fixtures.session.activeRun = {
    id: 'run-waiting-for-env',
    status: 'running',
    pendingAsk: null,
    pendingEnvRequest: {
      requestId: 'env-from-session',
      reason: 'Connect the deployment provider.',
      variables: [
        {
          key: 'DEPLOY_TOKEN',
          description: 'Token with deployment access.',
          secret: true,
        },
      ],
    },
  };
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
    openResponse(init?.signal),
  );
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

  const input = screen.getByLabelText(/^DEPLOY_TOKEN(?: \*)?$/);
  await expect.element(input).toBeVisible();
  const sentinel = 'private-value-not-in-query-cache';
  await input.fill(sentinel);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    '/api/agent/runs/run-waiting-for-env/events?after=0',
  );
  expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(sentinel);
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain(sentinel);
});

test('syncs changed prompt metadata without reconnecting the active stream', async () => {
  fixtures.session.activeRun = {
    id: 'run-with-refreshed-seed',
    status: 'running',
    pendingAsk: null,
    pendingEnvRequest: null,
  };
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
    openResponse(init?.signal),
  );
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

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  queryClient.setQueryData(['test-agent-session', 'session-1'], {
    ...structuredClone(fixtures.session),
    activeRun: {
      ...structuredClone(fixtures.session.activeRun!),
      pendingEnvRequest: {
        requestId: 'env-from-refetch',
        reason: 'Connect the deployment provider.',
        variables: [
          {
            key: 'DEPLOY_TOKEN',
            description: 'Token with deployment access.',
            secret: true,
          },
        ],
      },
    },
  });

  await expect
    .element(screen.getByLabelText(/^DEPLOY_TOKEN(?: \*)?$/))
    .toBeVisible();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    '/api/agent/runs/run-with-refreshed-seed/events?after=0',
  );
});

test('keeps reconnect backoff when an unchanged session refetch succeeds', async () => {
  fixtures.session.activeRun = {
    id: 'run-with-outage',
    status: 'running',
    pendingAsk: null,
    pendingEnvRequest: null,
  };
  const eventRequestTimes: number[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
    eventRequestTimes.push(performance.now());
    return eventRequestTimes.length === 1
      ? new Response(null, { status: 503 })
      : openResponse(init?.signal);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Chat sessionId="session-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );

  // The failed stream invalidates the session query. That unchanged refetch
  // must finish without opening a second stream ahead of the 750 ms timer.
  await vi.waitFor(() => expect(fixtures.sessionFetchCount).toBeGreaterThan(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), {
    timeout: 2000,
  });
  expect(eventRequestTimes[1]! - eventRequestTimes[0]!).toBeGreaterThanOrEqual(
    700,
  );
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
  expect(
    JSON.parse(localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY)!),
  ).toBe('provider-latest:model-latest');
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
    expectedSessionUpdatedAt: '2026-07-11T12:00:00.000Z',
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

test('refreshes a stale error after another tab has consumed its Retry', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/events')) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    if (url !== '/api/agent/runs') throw new Error(`Unexpected fetch: ${url}`);
    fixtures.session.updatedAt = '2026-07-11T12:01:00.000Z';
    fixtures.session.activeRun = {
      id: 'run-from-another-tab',
      status: 'running',
      pendingAsk: null,
      pendingEnvRequest: null,
    };
    return new Response('This chat already has a running Agent turn.', {
      status: 409,
    });
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
  await retry.click();

  await vi.waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === '/api/agent/runs',
      ),
    ).toHaveLength(1),
  );
  const startCall = fetchMock.mock.calls.find(
    ([input]) => String(input) === '/api/agent/runs',
  );
  expect(JSON.parse(String(startCall?.[1]?.body))).toEqual({
    sessionId: 'session-1',
    retry: true,
    expectedSessionUpdatedAt: '2026-07-11T12:00:00.000Z',
    providerId: 'provider-original',
    modelId: 'model:with-colon',
  });
  await expect.element(retry).not.toBeInTheDocument();
  expect(
    queryClient.getQueryData(['test-agent-session', 'session-1']),
  ).toMatchObject({
    updatedAt: '2026-07-11T12:01:00.000Z',
    activeRun: { id: 'run-from-another-tab' },
  });
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
    content: [{ type: 'text', text: 'Use the new model' }],
    images: [],
    attachmentIds: [],
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
