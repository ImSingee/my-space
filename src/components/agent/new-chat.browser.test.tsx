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
      attachmentIds: [],
      providerId: 'provider-b',
      modelId: 'model-b',
    },
    {
      sessionId: 'new-session',
      userText: 'Build with the latest model',
      images: [],
      attachmentIds: [],
      providerId: 'provider-b',
      modelId: 'model-b',
    },
  ]);
});

test('uploads a non-image file first and retains the draft when upload fails', async () => {
  let uploadAttempts = 0;
  const uploadedBodies: Uint8Array[] = [];
  const uploadedIds: string[] = [];
  let runBody: Record<string, unknown> | undefined;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith('/api/agent/sessions/new-session/attachments/')) {
      uploadAttempts += 1;
      uploadedIds.push(decodeURIComponent(url.split('/').at(-1) ?? ''));
      const file = init?.body as File;
      uploadedBodies.push(new Uint8Array(await file.arrayBuffer()));
      if (uploadAttempts === 1) {
        return new Response('Temporary upload failure', { status: 503 });
      }
      return Response.json({
        attachment: {
          id: uploadedIds.at(-1),
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          size: 5,
        },
      });
    }
    if (url === '/api/agent/runs') {
      runBody = JSON.parse(String(init?.body));
      return Response.json({ runId: 'new-run' });
    }
    throw new Error(`Unexpected fetch: ${url}`);
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
  const composer = screen.getByPlaceholder(
    'Describe the app you want to build…',
  );
  await composer.fill('Inspect this binary file');
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const transfer = new DataTransfer();
  transfer.items.add(
    new File([Uint8Array.from([0, 1, 255, 2, 3])], 'payload.bin', {
      type: 'application/octet-stream',
    }),
  );
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: transfer.files,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.element(screen.getByText('payload.bin')).toBeVisible();

  const send = screen.getByRole('button', { name: 'Send' });
  await send.click();
  await vi.waitFor(() => expect(uploadAttempts).toBe(1));
  await vi.waitFor(() => expect(send.element()).toBeEnabled());
  await expect.element(composer).toHaveValue('Inspect this binary file');
  await expect.element(screen.getByText('payload.bin')).toBeVisible();
  expect(onStart).not.toHaveBeenCalled();

  await send.click();
  await vi.waitFor(() => expect(onStart).toHaveBeenCalledWith('new-session'));

  expect(fixtures.createSession).toHaveBeenCalledOnce();
  expect(uploadedIds).toHaveLength(2);
  expect(uploadedIds[1]).toBe(uploadedIds[0]);
  expect(uploadedBodies).toEqual([
    Uint8Array.from([0, 1, 255, 2, 3]),
    Uint8Array.from([0, 1, 255, 2, 3]),
  ]);
  expect(runBody).toEqual({
    sessionId: 'new-session',
    userText: 'Inspect this binary file',
    images: [],
    attachmentIds: [uploadedIds[0]],
    providerId: 'provider-a',
    modelId: 'model-a',
  });
});
