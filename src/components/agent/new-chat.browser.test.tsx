import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { NewChat } from './new-chat';

const fixtures = vi.hoisted(() => ({
  createSession: vi.fn<() => Promise<{ id: string }>>(async () => ({
    id: 'new-session',
  })),
  providers: [
    {
      id: 'provider-a',
      name: 'Provider A',
      enabled: true,
      models: [
        {
          modelId: 'model-a',
          name: 'Model A',
          enabled: true,
        },
      ],
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      enabled: true,
      models: [
        {
          modelId: 'model-b',
          name: 'Model B',
          enabled: true,
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
}));

vi.mock('./new-chat-api', () => ({
  createEmptyAgentSession: fixtures.createSession,
}));

beforeEach(() => {
  fixtures.createSession.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('reuses its unbound session when the first run start fails', async () => {
  let runAttempts = 0;
  let rejectFirstStart: (() => void) | undefined;
  const firstStart = new Promise<Response>((resolve) => {
    rejectFirstStart = () =>
      resolve(
        new Response('The selected Agent model is unavailable.', {
          status: 409,
        }),
      );
  });
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url !== '/api/agent/runs') {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    runAttempts += 1;
    return runAttempts === 1 ? firstStart : Response.json({ runId: 'new-run' });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onStart = vi.fn<(sessionId: string) => void>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <NewChat onStart={onStart} />
      </MantineProvider>
    </QueryClientProvider>,
  );

  await screen.getByRole('button', { name: 'Model A' }).click();
  await screen.getByRole('menuitem', { name: 'Model B' }).click();
  const modelPicker = screen.getByRole('button', { name: 'Model B' });
  const composer = screen.getByPlaceholder(
    'Describe the app you want to build…',
  );
  await composer.fill('Build with the latest model');
  const send = screen.getByRole('button', { name: 'Send' });
  await send.click();

  await vi.waitFor(() => expect(runAttempts).toBe(1));
  await expect.element(modelPicker).toBeDisabled();
  rejectFirstStart?.();
  await vi.waitFor(() => expect(send.element()).toBeEnabled());
  await expect.element(composer).toHaveValue('Build with the latest model');
  expect(fixtures.createSession).toHaveBeenCalledOnce();
  expect(fixtures.createSession).toHaveBeenCalledWith();

  await send.click();
  await vi.waitFor(() => expect(onStart).toHaveBeenCalledWith('new-session'));

  expect(fixtures.createSession).toHaveBeenCalledOnce();
  const bodies = fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
  expect(bodies).toEqual([
    {
      sessionId: 'new-session',
      userText: 'Build with the latest model',
      images: [],
      providerId: 'provider-b',
      modelId: 'model-b',
    },
    {
      sessionId: 'new-session',
      userText: 'Build with the latest model',
      images: [],
      providerId: 'provider-b',
      modelId: 'model-b',
    },
  ]);
});
