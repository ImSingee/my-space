import { Box, MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type { AgentStreamEvent } from '~agent/events';
import type { SessionSnapshot } from '~queries/agent';
import type { AppListItem } from '~server/apps';
import { Chat } from './chat';
import type { ChatMessage } from './types';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn<(message: string, options?: { id?: string }) => void>(),
    dismiss: vi.fn<(id?: string | number) => void>(),
  },
}));

const fixtures = vi.hoisted(() => ({
  session: null as unknown,
  /** While set, session fetches wait for it (a refetch still in flight). */
  sessionGate: null as Promise<void> | null,
  failSessionFetch: false,
  sessionFetches: 0,
  apps: [] as unknown[],
  providers: [
    {
      id: 'provider-1',
      name: 'Provider',
      apiType: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      sortOrder: 0,
      models: [
        {
          id: 'model-row-1',
          modelId: 'model-1',
          name: 'Model One',
          reasoning: true,
          contextWindow: 128_000,
          maxTokens: 8_192,
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
      fixtures.sessionFetches += 1;
      if (fixtures.sessionGate) await fixtures.sessionGate;
      if (fixtures.failSessionFetch) throw new Error('Session refetch failed');
      return structuredClone(fixtures.session);
    },
  }),
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: {
    queryKey: ['test-apps'],
    queryFn: async () => fixtures.apps,
  },
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [],
  },
}));

const WORK_HEADER = /^Work(ing|ed)\b/;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function snapshot(overrides: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 'session-1',
    title: 'Tracker',
    appIds: [],
    providerId: 'provider-1',
    modelId: 'model-1',
    updatedAt: '2026-10-12T10:00:00.000Z',
    messages: [],
    activeRun: null,
    runs: [],
    serverTime: iso(Date.now()),
    clockOffsetMs: 0,
    ...overrides,
  };
}

type RunTiming = SessionSnapshot['runs'][number];

/** Timing of run-1, which answers the latest user turn of `messages`. */
function runOne(
  startedAt: number,
  messages: ChatMessage[],
  overrides: Partial<RunTiming> = {},
): RunTiming {
  return {
    id: 'run-1',
    status: 'running',
    userTurn: messages.filter((m) => m.role === 'user').length - 1,
    startedAt: iso(startedAt),
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function runningSession(
  startedAt: number,
  messages: ChatMessage[],
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return snapshot({
    messages: messages as SessionSnapshot['messages'],
    activeRun: {
      id: 'run-1',
      status: 'running',
      startedAt: iso(startedAt),
      userTurn: messages.filter((m) => m.role === 'user').length - 1,
      pendingAsk: null,
      pendingEnvRequest: null,
    },
    runs: [runOne(startedAt, messages)],
    ...overrides,
  });
}

/** A run's SSE stream whose events the test pushes one at a time. */
function liveStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let seq = 0;
  return {
    get connected() {
      return controller !== undefined;
    },
    response(signal?: AbortSignal | null) {
      const body = new ReadableStream<Uint8Array>({
        start(next) {
          controller = next;
        },
      });
      signal?.addEventListener(
        'abort',
        () => {
          try {
            controller?.close();
          } catch {
            // Already closed by a terminal event.
          }
        },
        { once: true },
      );
      return new Response(body, { status: 200 });
    },
    emit(event: AgentStreamEvent) {
      seq += 1;
      controller?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ seq, event })}\n\n`),
      );
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <MantineProvider>
        <Box h={560} style={{ display: 'flex', flexDirection: 'column' }}>
          <Chat sessionId="session-1" />
        </Box>
      </MantineProvider>
    ),
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/$appSlug',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, appRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { screen, queryClient };
}

function invalidateSession(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    queryKey: ['test-agent-session', 'session-1'],
  });
}

beforeEach(() => {
  fixtures.session = null;
  fixtures.sessionGate = null;
  fixtures.failSessionFetch = false;
  fixtures.sessionFetches = 0;
  fixtures.apps = [];
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('keeps a running reply open through every phase and folds its process once when the run completes', async () => {
  const startedAt = Date.now() - 5_000;
  const prompt: ChatMessage = { role: 'user', content: 'Build a tracker' };
  fixtures.session = runningSession(startedAt, [prompt]);
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen, queryClient } = await renderChat();

  const header = screen.getByRole('button', { name: WORK_HEADER });
  await expect.element(header).toHaveAccessibleName(/^Working \d+s$/);
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(screen.getByText('Thinking…', { exact: true }))
    .toBeVisible();

  // None of the intermediate phases may fold the process away.
  stream.emit({ type: 'assistant_start' });
  stream.emit({ type: 'thinking', delta: 'Planning the tracker.' });
  stream.emit({ type: 'text', delta: 'I will scaffold the tracker.' });
  stream.emit({
    type: 'tool_start',
    id: 'tool-1',
    name: 'list_apps',
    label: 'List apps',
    args: {},
  });
  stream.emit({
    type: 'tool_end',
    id: 'tool-1',
    name: 'list_apps',
    isError: false,
    output: '[]',
  });
  stream.emit({ type: 'turn_end' });
  stream.emit({ type: 'assistant_start' });
  stream.emit({ type: 'text', delta: 'Your tracker is ready.' });
  await expect
    .element(screen.getByText('Your tracker is ready.'))
    .toBeVisible();
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(screen.getByText('I will scaffold the tracker.'))
    .toBeVisible();

  // A manual collapse while running may hide the current prose too.
  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await expect
    .element(screen.getByText('Your tracker is ready.'))
    .not.toBeVisible();
  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');

  // The run ends while its canonical snapshot is still being fetched.
  const refetch = deferred();
  fixtures.sessionGate = refetch.promise;
  const completedAt = startedAt + 80_000;
  fixtures.session = snapshot({
    messages: [
      prompt,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Planning the tracker.' },
          { type: 'text', text: 'I will scaffold the tracker.' },
          { type: 'toolCall', id: 'tool-1', name: 'list_apps', arguments: {} },
        ],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolName: 'list_apps',
        content: [{ type: 'text', text: '[]' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Your tracker is ready.' }],
        stopReason: 'stop',
      },
    ] as SessionSnapshot['messages'],
    runs: [
      runOne(startedAt, [prompt], {
        status: 'completed',
        completedAt: iso(completedAt),
      }),
    ],
  });
  stream.emit({ type: 'done' });

  // Settled live turn: process folded once, final answer outside, no blank.
  await expect.element(header).toHaveAccessibleName(/^Worked \d+s$/);
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await expect
    .element(screen.getByText('Your tracker is ready.'))
    .toBeVisible();
  await expect
    .element(screen.getByText('I will scaffold the tracker.'))
    .not.toBeVisible();
  await expect
    .element(screen.getByText('Thinking…', { exact: true }))
    .not.toBeInTheDocument();

  // History replaces it with the server-measured duration and no duplicate.
  fixtures.sessionGate = null;
  refetch.resolve();
  await expect.element(header).toHaveAccessibleName('Worked 1m 20s');
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('Your tracker is ready.').all()).toHaveLength(1);
  await expect
    .element(screen.getByText('Your tracker is ready.'))
    .toBeVisible();

  // Reopening after completion survives refetches on this page.
  await header.click();
  await expect
    .element(screen.getByText('I will scaffold the tracker.'))
    .toBeVisible();
  await invalidateSession(queryClient);
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(screen.getByText('I will scaffold the tracker.'))
    .toBeVisible();

  // Navigating back resets it to the completed default.
  await screen.unmount();
  const revisit = await renderChat();
  const revisitedHeader = revisit.screen.getByRole('button', {
    name: 'Worked 1m 20s',
  });
  await expect
    .element(revisitedHeader)
    .toHaveAttribute('aria-expanded', 'false');
  await expect
    .element(revisit.screen.getByText('Your tracker is ready.'))
    .toBeVisible();
});

test('shows history with run-bound defaults and keeps essential actions outside', async () => {
  const base = Date.parse('2026-10-12T09:00:00.000Z');
  fixtures.apps = [
    {
      id: 'app-tracker',
      slug: 'tracker',
      name: 'Tracker',
      description: null,
      status: 'deployed',
      capabilities: {
        database: false,
        frontend: true,
        widgets: false,
        backend: false,
        cron: false,
        webhook: false,
        kv: false,
      },
      createdAt: '2026-10-12T09:00:00.000Z',
      updatedAt: '2026-10-12T09:00:00.000Z',
    } satisfies AppListItem,
  ];
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Deploy the tracker' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Deploying it now.' },
        {
          type: 'toolCall',
          id: 'deploy-1',
          name: 'deploy_app',
          arguments: { id: 'app-tracker' },
        },
      ],
    },
    {
      role: 'toolResult',
      toolName: 'deploy_app',
      content: [{ type: 'text', text: 'Deployed.' }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The tracker is live.' }],
      stopReason: 'stop',
    },
    // A reply from before runs recorded their user turn.
    { role: 'user', content: 'Explain it' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Legacy reasoning.' },
        { type: 'text', text: 'Legacy answer.' },
      ],
    },
    // An unbound reply with nothing before its answer shows no frame at all.
    { role: 'user', content: 'Ping' },
    { role: 'assistant', content: [{ type: 'text', text: 'Pong.' }] },
    // A reply with nothing before its answer has nothing to expand.
    { role: 'user', content: 'Say hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi there.' }] },
    // A finished reply without answer text is all process.
    { role: 'user', content: 'List my apps' },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'list-1', name: 'list_apps', arguments: {} },
      ],
    },
    { role: 'toolResult', toolName: 'list_apps', content: [] },
    // An interrupted run persisted no reply; its run still explains why.
    { role: 'user', content: 'Run the nightly report' },
    // A failed reply stays open with its reason and Retry.
    { role: 'user', content: 'Try again' },
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Calling the provider.' }],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    },
  ];
  const run = (
    userTurn: number,
    status: RunTiming['status'],
    ms: number,
    error: string | null = null,
  ): RunTiming => ({
    id: `run-${userTurn}`,
    status,
    userTurn,
    startedAt: iso(base + userTurn * 600_000),
    completedAt: iso(base + userTurn * 600_000 + ms),
    error,
  });
  const interruption =
    'Agent run was interrupted because its Agent Runner went away.';
  fixtures.session = snapshot({
    messages: messages as SessionSnapshot['messages'],
    runs: [
      run(0, 'completed', 80_000),
      run(3, 'completed', 2_000),
      run(4, 'completed', 3_000),
      run(5, 'interrupted', 4_000, interruption),
      run(6, 'failed', 5_000, 'Provider unavailable'),
    ],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();

  const deployed = screen.getByRole('button', { name: 'Worked 1m 20s' });
  await expect.element(deployed).toHaveAttribute('aria-expanded', 'false');
  await expect.element(screen.getByText('The tracker is live.')).toBeVisible();
  await expect.element(screen.getByText('Deploying it now.')).not.toBeVisible();
  await expect
    .element(
      screen
        .getByRole('region', { name: 'Deployed app' })
        .getByRole('link', { name: 'Open' }),
    )
    .toHaveAttribute('href', '/app/tracker');

  // Unbound history keeps the frame but never invents a duration.
  const legacy = screen.getByRole('button', { name: 'Worked', exact: true });
  await expect.element(legacy).toHaveAttribute('aria-expanded', 'false');
  await expect.element(screen.getByText('Legacy answer.')).toBeVisible();

  const pong = screen.getByText('Pong.');
  await expect.element(pong).toBeVisible();
  expect(pong.element().closest('[class*="assistantRow"]')?.textContent).toBe(
    'Pong.',
  );

  await expect.element(screen.getByText('Worked 2s')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Worked 2s' }).query()).toBeNull();
  await expect.element(screen.getByText('Hi there.')).toBeVisible();

  const listed = screen.getByRole('button', { name: 'Worked 3s' });
  await expect.element(listed).toHaveAttribute('aria-expanded', 'false');
  await expect.element(screen.getByText('List apps')).not.toBeVisible();

  await expect.element(screen.getByText('Worked 4s · Failed')).toBeVisible();
  await expect.element(screen.getByText(interruption)).toBeVisible();

  const failed = screen.getByRole('button', { name: 'Worked 5s · Failed' });
  await expect.element(failed).toHaveAttribute('aria-expanded', 'true');
  const reasoning = screen.getByRole('button', { name: 'Thinking' });
  await expect.element(reasoning).toBeVisible();
  expect(screen.getByText('Provider unavailable').all()).toHaveLength(1);
  await expect
    .element(screen.getByRole('button', { name: 'Retry' }))
    .toBeVisible();

  // Keyboard users can fold the frame through its disclosure button.
  const controls = failed.element().getAttribute('aria-controls');
  expect(controls && document.getElementById(controls)).toBeTruthy();
  (failed.element() as HTMLButtonElement).focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(failed).toHaveAttribute('aria-expanded', 'false');
  await vi.waitFor(() => expect(reasoning.query()).toBeNull());
});

test('counts a live run from the server start and freezes it when the run fails', async () => {
  const serverAhead = 3_600_000;
  const prompt: ChatMessage = { role: 'user', content: 'Connect GitHub' };
  // The server clock runs an hour ahead; the run started 65 server-seconds ago.
  fixtures.session = runningSession(
    Date.now() + serverAhead - 65_000,
    [prompt],
    {
      clockOffsetMs: serverAhead,
    },
  );
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();

  const header = screen.getByRole('button', { name: WORK_HEADER });
  await expect.element(header).toHaveAccessibleName(/^Working 1m [56]s$/);
  const first = header.element().textContent;
  await vi.waitFor(() => expect(header.element().textContent).not.toBe(first), {
    timeout: 2_500,
  });
  await expect.element(header).toHaveAccessibleName(/^Working 1m [67]s$/);

  // Human input stays reachable while the process is folded.
  stream.emit({ type: 'thinking', delta: 'Checking the GitHub scopes.' });
  stream.emit({ type: 'text', delta: 'I need a token first.' });
  stream.emit({
    type: 'ask',
    askId: 'ask-1',
    questions: [
      {
        id: 'scope',
        prompt: 'Which repositories?',
        options: [{ id: 'all', label: 'All repositories' }],
        allowMultiple: false,
      },
    ],
  });
  await expect.element(screen.getByText('Which repositories?')).toBeVisible();
  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await expect
    .element(screen.getByText('I need a token first.'))
    .not.toBeVisible();
  await expect.element(screen.getByText('Which repositories?')).toBeVisible();

  // The refetch after the failure is unavailable: the live turn must stay.
  fixtures.failSessionFetch = true;
  stream.emit({ type: 'error', message: 'Provider unavailable' });
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('Provider unavailable');
  await expect
    .element(header)
    .toHaveAccessibleName(/^Worked 1m \d+s · Failed$/);
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  const frozen = header.element().textContent;
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(header.element().textContent).toBe(frozen);
  await expect
    .element(screen.getByRole('button', { name: 'Thinking' }))
    .toBeVisible();
  await expect.element(screen.getByText('I need a token first.')).toBeVisible();
  expect(toast.error).not.toHaveBeenCalled();
});

function failingRun(prompt: ChatMessage) {
  const startedAt = Date.now() - 3_000;
  fixtures.session = runningSession(startedAt, [prompt]);
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).startsWith('/api/agent/runs/run-1/events')) {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const failedRun = runOne(startedAt, [prompt], {
    status: 'failed',
    completedAt: iso(startedAt + 3_000),
    error: 'Provider unavailable',
  });
  return { stream, failedRun };
}

test('hands a failed live turn to its persisted error without a toast', async () => {
  const prompt: ChatMessage = { role: 'user', content: 'Build it' };
  const { stream, failedRun } = failingRun(prompt);
  const { screen } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  const refetch = deferred();
  fixtures.sessionGate = refetch.promise;
  fixtures.session = snapshot({
    messages: [
      prompt,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Starting the build.' }],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ] as SessionSnapshot['messages'],
    runs: [failedRun],
  });
  stream.emit({ type: 'text', delta: 'Starting the build.' });
  stream.emit({ type: 'error', message: 'Provider unavailable' });
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('Provider unavailable');

  fixtures.sessionGate = null;
  refetch.resolve();
  await expect
    .element(screen.getByRole('note'))
    .toMatchTextContent('Provider unavailable');
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Starting the build.').all()).toHaveLength(1);
  await expect
    .element(screen.getByRole('button', { name: 'Retry' }))
    .toBeVisible();
  expect(toast.error).not.toHaveBeenCalled();
});

test('keeps an interrupted turn and its notice when its transcript never arrives', async () => {
  const prompt: ChatMessage = { role: 'user', content: 'Build it' };
  const { stream, failedRun } = failingRun(prompt);
  const interruption =
    'Agent run was interrupted because its Agent Runner went away.';
  const { screen, queryClient } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  stream.emit({ type: 'thinking', delta: 'Planning the build.' });
  stream.emit({ type: 'text', delta: 'Starting the build.' });
  // History already says the run ended, but its partial reply was never
  // saved: the turn the user saw must stay, with its interruption notice.
  fixtures.session = snapshot({
    messages: [prompt] as SessionSnapshot['messages'],
    runs: [{ ...failedRun, status: 'interrupted', error: interruption }],
  });
  stream.emit({ type: 'error', message: interruption });
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(interruption);
  await invalidateSession(queryClient);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent(interruption);
  await expect.element(screen.getByText('Starting the build.')).toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Worked 3s · Failed' }))
    .toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText(interruption).all()).toHaveLength(1);
  expect(toast.error).not.toHaveBeenCalled();

  // Coming back later, history still explains what happened to the turn.
  await screen.unmount();
  const revisit = await renderChat();
  await expect
    .element(revisit.screen.getByText('Worked 3s · Failed'))
    .toBeVisible();
  await expect
    .element(revisit.screen.getByRole('note'))
    .toMatchTextContent(interruption);
});

test('hands a failed run that showed nothing to its history notice', async () => {
  const prompt: ChatMessage = { role: 'user', content: 'Build it' };
  const { stream, failedRun } = failingRun(prompt);
  const rejected = 'No Agent Runner is connected.';
  const { screen } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  fixtures.session = snapshot({
    messages: [prompt] as SessionSnapshot['messages'],
    runs: [{ ...failedRun, error: rejected }],
  });
  stream.emit({ type: 'error', message: rejected });

  await expect.element(screen.getByRole('note')).toMatchTextContent(rejected);
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  await expect.element(screen.getByText('Worked 3s · Failed')).toBeVisible();
  expect(toast.error).not.toHaveBeenCalled();
});

test('folds earlier assistant messages even while history is unavailable', async () => {
  const prompt: ChatMessage = { role: 'user', content: 'Summarize it' };
  fixtures.session = runningSession(Date.now() - 2_000, [prompt]);
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  stream.emit({ type: 'assistant_start' });
  stream.emit({ type: 'text', delta: 'Process commentary.' });
  stream.emit({ type: 'assistant_start' });
  stream.emit({ type: 'text', delta: 'Final answer.' });
  await expect.element(screen.getByText('Final answer.')).toBeVisible();
  fixtures.failSessionFetch = true;
  stream.emit({ type: 'done' });

  const header = screen.getByRole('button', { name: WORK_HEADER });
  await expect.element(header).toHaveAccessibleName(/^Worked \d+s$/);
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await expect.element(screen.getByText('Final answer.')).toBeVisible();
  await expect
    .element(screen.getByText('Process commentary.'))
    .not.toBeVisible();
});

test('freezes a stopped run until its partial reply is persisted', async () => {
  const startedAt = Date.now() - 4_000;
  const prompt: ChatMessage = { role: 'user', content: 'Write the docs' };
  fixtures.session = runningSession(startedAt, [prompt]);
  const stream = liveStream();
  const cancel = deferred();
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/agent/runs/run-1/events?after=0') {
      return stream.response(init?.signal);
    }
    if (url === '/api/agent/runs/run-1/cancel') {
      await cancel.promise;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const { screen } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  stream.emit({ type: 'thinking', delta: 'Outlining sections.' });
  stream.emit({ type: 'text', delta: 'Drafting the introduction.' });
  await expect
    .element(screen.getByText('Drafting the introduction.'))
    .toBeVisible();

  await screen.getByRole('button', { name: 'Stop' }).click();
  const header = screen.getByRole('button', { name: WORK_HEADER });
  await expect.element(header).toHaveAccessibleName(/^Worked \d+s · Stopped$/);
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(screen.getByText('Drafting the introduction.'))
    .toBeVisible();
  // Still busy until the cancellation is confirmed.
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();

  fixtures.session = snapshot({
    messages: [
      prompt,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Outlining sections.' },
          { type: 'text', text: 'Drafting the introduction.' },
        ],
        stopReason: 'aborted',
      },
    ] as SessionSnapshot['messages'],
    runs: [
      runOne(startedAt, [prompt], {
        status: 'cancelled',
        completedAt: iso(startedAt + 6_000),
      }),
    ],
  });
  cancel.resolve();

  await expect.element(header).toHaveAccessibleName('Worked 6s · Stopped');
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Drafting the introduction.').all()).toHaveLength(1);
  await expect
    .element(screen.getByRole('button', { name: 'Send' }))
    .toBeVisible();
});

test('keeps a remotely stopped turn until its late partial transcript arrives', async () => {
  const startedAt = Date.now() - 4_000;
  const prompt: ChatMessage = { role: 'user', content: 'Write the docs' };
  fixtures.session = runningSession(startedAt, [prompt]);
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));

  stream.emit({ type: 'thinking', delta: 'Outlining sections.' });
  stream.emit({ type: 'text', delta: 'Drafting the introduction.' });
  await expect
    .element(screen.getByText('Drafting the introduction.'))
    .toBeVisible();

  // Another tab stopped the run: it is terminal before the Runner reports.
  const cancelled = runOne(startedAt, [prompt], {
    status: 'cancelled',
    completedAt: iso(startedAt + 6_000),
  });
  fixtures.session = snapshot({
    messages: [prompt] as SessionSnapshot['messages'],
    runs: [cancelled],
  });
  stream.emit({ type: 'cancelled' });

  const header = screen.getByRole('button', { name: WORK_HEADER });
  // The canonical end is used once history knows it.
  await expect.element(header).toHaveAccessibleName('Worked 6s · Stopped');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect
    .element(screen.getByText('Drafting the introduction.'))
    .toBeVisible();

  // The Runner's late report lands; a follow-up refetch swaps in history.
  fixtures.session = snapshot({
    messages: [
      prompt,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Outlining sections.' },
          { type: 'text', text: 'Drafting the introduction.' },
        ],
        stopReason: 'aborted',
      },
    ] as SessionSnapshot['messages'],
    runs: [cancelled],
  });
  const fetchesBeforeReport = fixtures.sessionFetches;
  await vi.waitFor(
    () => expect(fixtures.sessionFetches).toBeGreaterThan(fetchesBeforeReport),
    { timeout: 4_000 },
  );
  await expect
    .element(screen.getByText('Drafting the introduction.'))
    .toBeVisible();
  expect(screen.getByText('Drafting the introduction.').all()).toHaveLength(1);
  await expect.element(header).toHaveAccessibleName('Worked 6s · Stopped');
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
});

test('binds a run from before recorded user turns to its own snapshot', async () => {
  const startedAt = Date.now() - 4_000;
  const history: ChatMessage[] = [
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }] },
    { role: 'user', content: 'Legacy request' },
  ];
  const legacyRun = {
    id: 'run-1',
    status: 'running' as const,
    startedAt: iso(startedAt),
    // Derived by the server from this snapshot's last user message.
    userTurn: 1,
    pendingAsk: null,
    pendingEnvRequest: null,
  };
  // The run predates recorded turns, so it has no timing entry.
  fixtures.session = snapshot({
    messages: history as SessionSnapshot['messages'],
    activeRun: legacyRun,
  });
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen, queryClient } = await renderChat();
  await vi.waitFor(() => expect(stream.connected).toBe(true));
  stream.emit({ type: 'thinking', delta: 'Recalling the setup.' });
  stream.emit({ type: 'text', delta: 'Legacy final.' });
  await expect.element(screen.getByText('Legacy final.')).toBeVisible();

  // Its reply is saved while the run still reads as active.
  const reply: ChatMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Recalling the setup.' },
      { type: 'text', text: 'Legacy final.' },
    ],
    stopReason: 'stop',
  };
  fixtures.session = snapshot({
    messages: [...history, reply] as SessionSnapshot['messages'],
    activeRun: legacyRun,
  });
  await invalidateSession(queryClient);
  expect(screen.getByText('Legacy final.').all()).toHaveLength(1);
  await expect.element(screen.getByText('Old answer.')).toBeVisible();

  // It ends while history cannot be read: still exactly one copy.
  fixtures.failSessionFetch = true;
  stream.emit({ type: 'done' });
  const header = screen.getByRole('button', { name: WORK_HEADER });
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('Legacy final.').all()).toHaveLength(1);

  // History returns without the run; the reply swaps in, duration unguessed.
  fixtures.failSessionFetch = false;
  fixtures.session = snapshot({
    messages: [...history, reply] as SessionSnapshot['messages'],
  });
  await invalidateSession(queryClient);
  await expect.element(header).toHaveAccessibleName('Worked');
  expect(screen.getByText('Legacy final.').all()).toHaveLength(1);
  await expect.element(screen.getByText('Legacy final.')).toBeVisible();
  await expect.element(screen.getByText('Old answer.')).toBeVisible();
});

test('does not bind a just-started run to an earlier turn', async () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'Old question' },
    { role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }] },
  ];
  fixtures.session = snapshot({
    messages: history as SessionSnapshot['messages'],
  });
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/agent/runs') {
        // History cannot catch up with the new run yet.
        fixtures.sessionGate = new Promise(() => {});
        return Response.json({ runId: 'run-1', startedAt: iso(Date.now()) });
      }
      if (url === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  const { screen } = await renderChat();
  await expect.element(screen.getByText('Old answer.')).toBeVisible();

  await screen.getByPlaceholder('Message the Agent…').fill('New question');
  await screen.getByRole('button', { name: 'Send' }).click();
  await vi.waitFor(() => expect(stream.connected).toBe(true));
  stream.emit({ type: 'text', delta: 'New answer.' });

  await expect.element(screen.getByText('New answer.')).toBeVisible();
  await expect.element(screen.getByText('Old answer.')).toBeVisible();
});

test('retries a failed turn without resurrecting its superseded failure', async () => {
  const base = Date.now() - 600_000;
  // The retried prompt is message 4 but user turn 1: the earlier reply spans
  // several messages, so a raw message index would bind the wrong turn.
  const earlier: ChatMessage[] = [
    { role: 'user', content: 'Deploy the tracker' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Deploying it now.' },
        { type: 'toolCall', id: 'list-1', name: 'list_apps', arguments: {} },
      ],
      stopReason: 'toolUse',
    },
    { role: 'toolResult', toolName: 'list_apps', content: [] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The tracker is live.' }],
      stopReason: 'stop',
    },
  ];
  const prompt: ChatMessage = { role: 'user', content: 'Add a dark mode' };
  const completedRun: RunTiming = {
    id: 'run-0',
    status: 'completed',
    userTurn: 0,
    startedAt: iso(base),
    completedAt: iso(base + 80_000),
    error: null,
  };
  fixtures.session = snapshot({
    messages: [
      ...earlier,
      prompt,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Starting on dark mode.' }],
        stopReason: 'error',
        errorMessage: 'Old provider error',
      },
    ] as SessionSnapshot['messages'],
    runs: [
      completedRun,
      {
        id: 'run-old',
        status: 'failed',
        userTurn: 1,
        startedAt: iso(base + 100_000),
        completedAt: iso(base + 105_000),
        error: 'Old provider error',
      },
    ],
  });
  const stream = liveStream();
  let retryStartedAt = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === '/api/agent/runs') {
        // History cannot be read again until the test allows it.
        fixtures.failSessionFetch = true;
        retryStartedAt = Date.now();
        return Response.json({
          runId: 'run-retry',
          startedAt: iso(retryStartedAt),
        });
      }
      if (url === '/api/agent/runs/run-retry/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  const { screen, queryClient } = await renderChat();
  await expect.element(screen.getByText('Old provider error')).toBeVisible();

  await screen.getByRole('button', { name: 'Retry' }).click();
  await vi.waitFor(() => expect(stream.connected).toBe(true));
  stream.emit({ type: 'thinking', delta: 'Choosing a palette.' });
  stream.emit({ type: 'text', delta: 'Adding the dark theme.' });
  await expect
    .element(screen.getByText('Adding the dark theme.'))
    .toBeVisible();

  // Only the replacement run speaks for the retried turn.
  await expect
    .element(screen.getByRole('button', { name: /^Working \d+s$/ }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain('Old provider error');
  expect(document.body.textContent).not.toContain('· Failed');
  expect(document.body.textContent).not.toContain('Starting on dark mode.');
  expect(screen.getByText('Add a dark mode').all()).toHaveLength(1);
  // The earlier turn keeps its own run.
  await expect
    .element(screen.getByRole('button', { name: 'Worked 1m 20s' }))
    .toHaveAttribute('aria-expanded', 'false');
  await expect.element(screen.getByText('The tracker is live.')).toBeVisible();

  // The replacement fails too, while history is still unreadable.
  stream.emit({ type: 'error', message: 'New provider error' });
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('New provider error');
  expect(screen.getByRole('button', { name: /· Failed$/ }).all()).toHaveLength(
    1,
  );
  expect(document.body.textContent).not.toContain('Old provider error');

  // History catches up with the new failure and replaces the live turn.
  fixtures.failSessionFetch = false;
  fixtures.session = snapshot({
    updatedAt: '2026-10-12T10:05:00.000Z',
    messages: [
      ...earlier,
      prompt,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Choosing a palette.' },
          { type: 'text', text: 'Adding the dark theme.' },
        ],
        stopReason: 'error',
        errorMessage: 'New provider error',
      },
    ] as SessionSnapshot['messages'],
    runs: [
      completedRun,
      {
        id: 'run-retry',
        status: 'failed',
        userTurn: 1,
        startedAt: iso(retryStartedAt),
        completedAt: iso(retryStartedAt + 2_000),
        error: 'New provider error',
      },
    ],
  });
  await invalidateSession(queryClient);
  await expect
    .element(screen.getByRole('note'))
    .toMatchTextContent('New provider error');
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Adding the dark theme.').all()).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Old provider error');
  await expect
    .element(screen.getByRole('button', { name: 'Retry' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Worked 1m 20s' }))
    .toHaveAttribute('aria-expanded', 'false');
});

test('keeps a reopened work process in place instead of following to the bottom', async () => {
  const base = Date.now() - 600_000;
  const calls = Array.from({ length: 30 }, (_, index) => ({
    type: 'toolCall' as const,
    id: `inspect-${index}`,
    name: 'get_app',
    arguments: { id: `app-${index}` },
  }));
  fixtures.session = snapshot({
    messages: [
      { role: 'user', content: 'Audit every app' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Starting the audit.' }, ...calls],
        stopReason: 'toolUse',
      },
      ...calls.map((call) => ({
        role: 'toolResult' as const,
        toolName: call.name,
        content: [{ type: 'text', text: 'Healthy.' }],
      })),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'All apps are healthy.' }],
        stopReason: 'stop',
      },
    ] as SessionSnapshot['messages'],
    runs: [
      {
        id: 'run-0',
        status: 'completed',
        userTurn: 0,
        startedAt: iso(base),
        completedAt: iso(base + 80_000),
        error: null,
      },
    ],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();
  const header = screen.getByRole('button', { name: 'Worked 1m 20s' });
  await expect.element(header).toBeInViewport();

  // Opening a finished reply is reading: the taller transcript must not pull
  // the reader to the bottom, away from the process they just opened.
  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'true');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await expect.element(header).toBeInViewport();
  await expect
    .element(screen.getByText('Starting the audit.'))
    .toBeInViewport();

  await header.click();
  await expect.element(header).toHaveAttribute('aria-expanded', 'false');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await expect.element(header).toBeInViewport();
  await expect.element(screen.getByText('All apps are healthy.')).toBeVisible();
});

test('keeps the final answer in view when a long process folds on completion', async () => {
  const startedAt = Date.now() - 2_000;
  const prompt: ChatMessage = { role: 'user', content: 'Audit every app' };
  fixtures.session = runningSession(startedAt, [prompt]);
  const stream = liveStream();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === '/api/agent/runs/run-1/events?after=0') {
        return stream.response(init?.signal);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }),
  );
  const { screen } = await renderChat();
  await expect
    .element(screen.getByRole('button', { name: WORK_HEADER }))
    .toBeVisible();

  for (let index = 0; index < 30; index += 1) {
    stream.emit({ type: 'text', delta: `Checked app ${index}.` });
    stream.emit({
      type: 'tool_start',
      id: `tool-${index}`,
      name: 'get_app',
      label: `Inspect app ${index}`,
      args: {},
    });
    stream.emit({
      type: 'tool_end',
      id: `tool-${index}`,
      name: 'get_app',
      isError: false,
    });
    stream.emit({ type: 'assistant_start' });
  }
  stream.emit({ type: 'text', delta: 'All apps are healthy.' });
  await expect
    .element(screen.getByText('All apps are healthy.'))
    .toBeInViewport();
  await expect.element(screen.getByText('Checked app 0.')).not.toBeInViewport();

  fixtures.sessionGate = new Promise(() => {});
  stream.emit({ type: 'done' });
  await expect
    .element(screen.getByRole('button', { name: WORK_HEADER }))
    .toHaveAttribute('aria-expanded', 'false');
  await expect
    .element(screen.getByText('All apps are healthy.'))
    .toBeInViewport();
});
