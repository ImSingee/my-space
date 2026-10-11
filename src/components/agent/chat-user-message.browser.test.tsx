import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { Chat } from './chat';

const fixtures = vi.hoisted(() => ({
  sessionFetchCount: 0,
  session: {
    id: 'session-1',
    title: 'Long prompts',
    appIds: [],
    providerId: 'provider-1',
    modelId: 'model-1',
    updatedAt: '2026-10-12T12:00:00.000Z',
    messages: [] as unknown[],
    activeRun: null as null | {
      id: string;
      status: 'running';
      pendingAsk: null;
      pendingEnvRequest: null;
    },
  },
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
          name: 'Model',
          reasoning: false,
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
      fixtures.sessionFetchCount += 1;
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

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [],
  },
}));

const longPrompt = Array.from(
  { length: 30 },
  (_, index) => `Requirement ${index + 1}: keep the tracker usable offline.`,
).join('\n');

const longReply = Array.from(
  { length: 12 },
  (_, index) =>
    `Step ${index + 1} of the plan explains one more part of the build.`,
).join('\n\n');

function user(text: string) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistant(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
  };
}

let queryClient: QueryClient;

beforeEach(() => {
  fixtures.sessionFetchCount = 0;
  fixtures.session.messages = [];
  fixtures.session.activeRun = null;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderChat() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <div style={{ height: 640, display: 'flex', flexDirection: 'column' }}>
          <Chat sessionId="session-1" />
        </div>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

function viewportOf(element: Element): HTMLElement {
  const viewport = element.closest<HTMLElement>('[data-scrollarea-viewport]');
  if (!viewport) throw new TypeError('Expected the chat scroll viewport');
  return viewport;
}

function distanceFromBottom(viewport: HTMLElement) {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
}

function topOffset(element: Element, viewport: HTMLElement) {
  return (
    element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
  );
}

/** Let resize observers and scroll events from the last layout settle. */
async function settleLayout() {
  for (let frame = 0; frame < 2; frame++) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
}

test('keeps an expanded prompt across session refetches and collapses it again when reopened', async () => {
  fixtures.session.messages = [user(longPrompt), assistant('Done.')];
  const screen = await renderChat();

  await screen.getByRole('button', { name: 'Expand message' }).click();
  await expect
    .element(screen.getByRole('button', { name: 'Collapse message' }))
    .toHaveAttribute('aria-expanded', 'true');
  const fetches = fixtures.sessionFetchCount;
  await queryClient.refetchQueries({
    queryKey: ['test-agent-session', 'session-1'],
  });
  expect(fixtures.sessionFetchCount).toBe(fetches + 1);
  await settleLayout();
  await expect
    .element(screen.getByRole('button', { name: 'Collapse message' }))
    .toHaveAttribute('aria-expanded', 'true');

  // The cached session survives navigation; the reader's choice does not.
  await screen.unmount();
  const reopened = await renderChat();
  await expect
    .element(reopened.getByRole('button', { name: 'Expand message' }))
    .toHaveAttribute('aria-expanded', 'false');
});

test('brings a collapsed prompt top back into view only when it was above the viewport', async () => {
  fixtures.session.messages = [user(longPrompt), assistant(longReply)];
  const screen = await renderChat();

  await screen.getByRole('button', { name: 'Expand message' }).click();
  const collapse = screen.getByRole('button', { name: 'Collapse message' });
  await expect.element(collapse).toBeVisible();
  const viewport = viewportOf(collapse.element());
  const bubble = collapse.element().closest('.mantine-Paper-root')!;

  // Reading to the end of the expanded prompt leaves its top above the view.
  collapse.element().scrollIntoView({ block: 'end' });
  await settleLayout();
  expect(topOffset(bubble, viewport)).toBeLessThan(0);
  await collapse.click();
  const expand = screen.getByRole('button', { name: 'Expand message' });
  await expect.element(expand).toHaveAttribute('aria-expanded', 'false');
  expect(Math.abs(topOffset(bubble, viewport))).toBeLessThanOrEqual(1);
  await expect.element(expand).toBeInViewport();

  // A prompt whose top is still visible stays where the reader left it.
  viewport.scrollTop = 0;
  await settleLayout();
  expect(topOffset(bubble, viewport)).toBeGreaterThan(0);
  await expand.click();
  await expect.element(collapse).toBeInTheDocument();
  expect(viewport.scrollTop).toBe(0);
  (collapse.element() as HTMLElement).focus({ preventScroll: true });
  await userEvent.keyboard('{Enter}');
  await expect.element(expand).toHaveAttribute('aria-expanded', 'false');
  expect(viewport.scrollTop).toBe(0);
});

test('keeps streaming follow paused after a tail prompt toggle until a real new message lands', async () => {
  fixtures.session.messages = [
    user('Earlier question'),
    assistant(longReply),
    user(longPrompt),
  ];
  fixtures.session.activeRun = {
    id: 'run-follow',
    status: 'running',
    pendingAsk: null,
    pendingEnvRequest: null,
  };
  let seq = 0;
  let push: ((event: object) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (!String(input).includes('/events')) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            push = (event) => {
              seq += 1;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ seq, event })}\n\n`),
              );
            };
            init?.signal?.addEventListener('abort', () => controller.close(), {
              once: true,
            });
          },
        }),
        { status: 200 },
      );
    }),
  );
  const stream = (delta: string) => push!({ type: 'text', delta });
  const screen = await renderChat();

  await vi.waitFor(() => expect(push).toBeDefined());
  stream('First streamed paragraph.');
  await expect
    .element(screen.getByText('First streamed paragraph.'))
    .toBeVisible();
  const toggle = screen.getByRole('button', { name: 'Expand message' });
  await expect.element(toggle).toBeInViewport();
  const viewport = viewportOf(toggle.element());
  await vi.waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(1));

  // Streamed tokens are not messages and must not pull the reader away.
  const readingTop = viewport.scrollTop;
  await toggle.click();
  await expect
    .element(screen.getByRole('button', { name: 'Collapse message' }))
    .toBeVisible();
  stream(
    Array.from({ length: 10 }, (_, index) => `\n\nStreamed line ${index}`).join(
      '',
    ),
  );
  await expect.element(screen.getByText('Streamed line 9')).toBeVisible();
  await settleLayout();
  expect(viewport.scrollTop).toBe(readingTop);
  expect(distanceFromBottom(viewport)).toBeGreaterThan(80);

  // Collapsing and landing at the very bottom only produce scroll events;
  // the pause outlives them.
  await screen.getByRole('button', { name: 'Collapse message' }).click();
  await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
  viewport.scrollTop = viewport.scrollHeight;
  await settleLayout();
  const pausedTop = viewport.scrollTop;
  stream('\n\nStill streaming while paused.');
  await expect
    .element(screen.getByText('Still streaming while paused.'))
    .toBeVisible();
  await settleLayout();
  expect(viewport.scrollTop).toBe(pausedTop);
  expect(distanceFromBottom(viewport)).toBeGreaterThan(10);

  // The persisted reply is a real new message, so follow resumes.
  fixtures.session.messages = [
    ...fixtures.session.messages,
    assistant('Persisted reply.'),
  ];
  fixtures.session.activeRun = null;
  push!({ type: 'done' });
  await expect.element(screen.getByText('Persisted reply.')).toBeVisible();
  await vi.waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(1));
});

test('opens a session at the bottom after long prompts gain their toggles', async () => {
  fixtures.session.messages = [
    user(longPrompt),
    assistant(longReply),
    user(longPrompt),
  ];
  const screen = await renderChat();

  const latest = screen.getByRole('button', { name: 'Expand message' }).nth(1);
  await expect.element(latest).toBeInTheDocument();
  const viewport = viewportOf(latest.element());
  await vi.waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(1));
  await expect.element(latest).toBeInViewport();
});
