import { Box, MantineProvider } from '@mantine/core';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { getRouter } from '~/router';
import type { SessionDetail } from '~server/agent-sessions';

const fixtures = vi.hoisted(() => ({
  streaming: false,
}));

vi.mock('~queries/agent', () => ({
  providersQueryOptions: {
    queryKey: ['scroll-test-providers'],
    queryFn: async () => [],
  },
  sessionsQueryOptions: {
    queryKey: ['scroll-test-sessions'],
    queryFn: async () => [],
  },
  sessionQueryOptions: (id: string) => ({
    queryKey: ['scroll-test-session', id],
    queryFn: async () => ({
      id,
      title: id,
      appIds: [],
      providerId: null,
      modelId: null,
      updatedAt: '2026-10-11T12:00:00.000Z',
      // Equal message counts ensure only the session identity resets scrolling.
      // Each reply answers its own prompt: consecutive assistant messages are
      // one reply, whose earlier messages fold into its work process.
      messages: Array.from({ length: id === 'empty' ? 0 : 12 }, (_, index) => [
        { role: 'user', content: `${id} prompt ${index}` },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `${id} reply ${index}\n\n${'A paragraph of conversation history.\n\n'.repeat(id === 'long' ? 18 : 2)}`,
            },
            ...(id === 'nested' && index === 11
              ? [
                  {
                    type: 'thinking',
                    thinking: 'Nested thinking line.\n'.repeat(100),
                  },
                ]
              : []),
          ],
        },
      ]).flat(),
      activeRun: fixtures.streaming
        ? {
            id: 'scroll-run',
            status: 'running',
            startedAt: '2026-10-11T12:00:00.000Z',
            userTurn: null,
            pendingAsk: null,
            pendingEnvRequest: null,
          }
        : null,
      runs: [],
      serverTime: '2026-10-11T12:00:00.000Z',
      clockOffsetMs: 0,
    }),
  }),
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: { queryKey: ['scroll-test-apps'], queryFn: async () => [] },
}));
vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['scroll-test-workflows'],
    queryFn: async () => [],
  },
}));

// Keep the production router configuration and Chat; replace only unrelated
// platform routes and server-backed data with an isolated browser fixture.
vi.mock('~/routeTree.gen', async () => {
  const { createRootRouteWithContext, createRoute, Outlet } =
    await import('@tanstack/react-router');
  const { Chat } = await import('./chat');
  const { sessionQueryOptions, providersQueryOptions } =
    await import('~queries/agent');
  const root = createRootRouteWithContext<{
    queryClient: import('@tanstack/react-query').QueryClient;
  }>()({
    component: () => (
      <Box h={600} style={{ display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
    ),
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: '/agent/$threadId',
    loader: async ({ context, params }) => {
      await Promise.all([
        context.queryClient.ensureQueryData(
          sessionQueryOptions(params.threadId),
        ),
        context.queryClient.ensureQueryData(providersQueryOptions),
      ]);
    },
    component: () => {
      const { threadId } = chat.useParams();
      return <Chat key={threadId} sessionId={threadId} />;
    },
  });
  const apps = createRoute({
    getParentRoute: () => root,
    path: '/apps',
    component: () => (
      <div
        data-scroll-restoration-id="ordinary-list"
        style={{ height: 400, overflowY: 'auto' }}
      >
        {Array.from({ length: 100 }, (_, i) => (
          <p key={i}>Application {i}</p>
        ))}
      </div>
    ),
  });
  return { routeTree: root.addChildren([chat, apps]) };
});

afterEach(() => {
  fixtures.streaming = false;
  vi.unstubAllGlobals();
});

function chatViewport() {
  const el = document.querySelector<HTMLDivElement>(
    '.mantine-ScrollArea-viewport',
  );
  if (!el || el.clientHeight === 0)
    throw new Error('Chat viewport not visible');
  return el;
}

function bottomGap() {
  const el = chatViewport();
  return el.scrollHeight - el.clientHeight - el.scrollTop;
}

async function settleScroll() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

async function mountChat(sessionId = 'short') {
  const router = getRouter();
  router.update({
    context: router.options.context,
    history: createMemoryHistory({ initialEntries: [`/agent/${sessionId}`] }),
  });
  await router.load();
  const screen = await render(
    <MantineProvider>
      <RouterProvider router={router} />
    </MantineProvider>,
  );
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  return { router, screen };
}

test('enters every session at the bottom after selection, reentry and Back', async () => {
  const { router } = await mountChat();
  const shortBottom = chatViewport().scrollTop;
  expect(shortBottom).toBeGreaterThan(100);
  await router.navigate({
    to: '/agent/$threadId',
    params: { threadId: 'long' },
  });
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('long reply 11');
  await settleScroll();
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  expect(chatViewport().scrollTop).toBeGreaterThan(shortBottom + 1000);

  chatViewport().scrollTop = 200;
  await settleScroll();
  await router.navigate({
    to: '/agent/$threadId',
    params: { threadId: 'short' },
  });
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('short reply 11');
  await settleScroll();
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  router.history.back();
  await expect.poll(() => router.state.location.pathname).toBe('/agent/long');
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('long reply 11');
  await settleScroll();
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
});

test('keeps ordinary page scroll restoration enabled', async () => {
  const { router } = await mountChat();
  await router.navigate({ to: '/apps' });
  const list = document.querySelector<HTMLDivElement>(
    '[data-scroll-restoration-id="ordinary-list"]',
  )!;
  list.scrollTop = 300;
  await settleScroll();
  await router.navigate({
    to: '/agent/$threadId',
    params: { threadId: 'long' },
  });
  await settleScroll();
  router.history.back();
  await expect.poll(() => router.state.location.pathname).toBe('/apps');
  await settleScroll();
  expect(
    document.querySelector<HTMLDivElement>(
      '[data-scroll-restoration-id="ordinary-list"]',
    )!.scrollTop,
  ).toBe(300);
});

test('stays at the bottom when loaded content changes height without a new message', async () => {
  const { router } = await mountChat();
  const viewport = chatViewport();
  const originalHeight = viewport.scrollHeight;
  const queryClient = router.options.context.queryClient;
  queryClient.setQueryData<SessionDetail>(
    ['scroll-test-session', 'short'],
    (old) =>
      old
        ? {
            ...old,
            messages: old.messages.map((message, index) =>
              index === 1
                ? {
                    role: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: 'Late loaded content.\n\n'.repeat(30),
                      },
                    ],
                  }
                : message,
            ),
          }
        : old,
  );
  await expect
    .poll(() => viewport.scrollHeight)
    .toBeGreaterThan(originalHeight + 500);
  await settleScroll();
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
});

async function mountStreamingChat(sessionId = 'short') {
  fixtures.streaming = true;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              init?.signal?.addEventListener('abort', () => value.close(), {
                once: true,
              });
            },
          }),
        ),
    ),
  );
  const { router, screen } = await mountChat(sessionId);
  await expect.poll(() => Boolean(controller)).toBe(true);
  let seq = 0;
  const emit = (delta: string) =>
    controller!.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ seq: ++seq, event: { type: 'text', delta } })}\n\n`,
      ),
    );
  return { router, screen, emit };
}

test('follows streaming at the bottom and preserves manual history reading', async () => {
  const { router, emit } = await mountStreamingChat();
  emit('First streaming reply.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('First streaming reply.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  chatViewport().scrollTop = 200;
  await settleScroll();
  emit('More streaming output.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('More streaming output.');
  await settleScroll();
  expect(chatViewport().scrollTop).toBe(200);
  // Same-length background data refresh must also preserve the reading position.
  await router.options.context.queryClient.invalidateQueries({
    queryKey: ['scroll-test-session', 'short'],
  });
  await settleScroll();
  expect(chatViewport().scrollTop).toBe(200);
});

test('preserves upward scrolling before the programmatic scroll event arrives', async () => {
  const { emit } = await mountStreamingChat();
  emit('First streaming reply.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('First streaming reply.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  await settleScroll();
  const viewport = chatViewport();
  const nativeScrollTo = viewport.scrollTo.bind(viewport);
  let readingTop: number | undefined;
  const spy = vi
    .spyOn(viewport, 'scrollTo')
    .mockImplementationOnce((options: ScrollToOptions | number, y?: number) => {
      if (typeof options === 'number') nativeScrollTo(options, y ?? 0);
      else nativeScrollTo(options);
      // Coalesce programmatic follow and an upward move before the scroll event.
      queueMicrotask(() => {
        viewport.scrollTop -= 200;
        readingTop = viewport.scrollTop;
      });
    });
  try {
    emit('Second streaming reply.\n\n'.repeat(20));
    await expect.poll(() => readingTop).toBeDefined();
    await settleScroll();
    expect(viewport.scrollTop).toBe(readingTop);
    expect(bottomGap()).toBe(200);
    const originalHeight = viewport.scrollHeight;
    emit('Third streaming reply.\n\n'.repeat(20));
    await expect
      .poll(() => viewport.scrollHeight)
      .toBeGreaterThan(originalHeight + 500);
    await settleScroll();
    expect(viewport.scrollTop).toBe(readingTop);
  } finally {
    spy.mockRestore();
  }
});

test('keeps mixed-case session URLs under the Chat scroll policy', async () => {
  const { router } = await mountChat();
  await router.navigate({ to: '/Agent/long' as never });
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('long reply 11');
  await settleScroll();
  const policy = router.options.scrollRestoration;
  expect(typeof policy).toBe('function');
  expect(
    typeof policy === 'function'
      ? policy({ location: router.state.location })
      : policy,
  ).toBe(false);
  expect(bottomGap()).toBeLessThanOrEqual(2);
  chatViewport().scrollTop = 200;
  await settleScroll();
  await router.navigate({
    to: '/agent/$threadId',
    params: { threadId: 'short' },
  });
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('short reply 11');
  router.history.back();
  await expect.poll(() => router.state.location.pathname).toBe('/Agent/long');
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('long reply 11');
  await settleScroll();
  expect(bottomGap()).toBeLessThanOrEqual(2);
});

function sendUpwardInput(viewport: HTMLDivElement, input: 'wheel' | 'touch') {
  if (input === 'wheel') {
    viewport.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -200,
        bubbles: true,
        cancelable: true,
      }),
    );
  } else {
    const touch = (clientY: number) =>
      new Touch({ identifier: 1, target: viewport, clientY });
    viewport.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [touch(100)],
        bubbles: true,
        cancelable: true,
      }),
    );
    viewport.dispatchEvent(
      new TouchEvent('touchmove', {
        touches: [touch(300)],
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

test('preserves manual upward scrolling before its scroll event', async () => {
  const { emit } = await mountStreamingChat();
  emit('First streaming reply.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('First streaming reply.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  await settleScroll();
  const viewport = chatViewport();
  viewport.scrollTop -= 200;
  const readingTop = viewport.scrollTop;
  emit('More streaming output.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('More streaming output.');
  await settleScroll();
  expect(viewport.scrollTop).toBe(readingTop);
  expect(bottomGap()).toBeGreaterThan(500);
  // Explicitly returning to the bottom resumes streaming follow.
  viewport.scrollTop = viewport.scrollHeight;
  await settleScroll();
  emit('Follow resumed.\n\n'.repeat(20));
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('Follow resumed.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
});

test('keeps following after an upward gesture cannot scroll a short reply', async () => {
  const { emit } = await mountStreamingChat('empty');
  emit('A short streaming reply.');
  await expect
    .poll(() => chatViewport().textContent)
    .toContain('A short streaming reply.');
  await settleScroll();
  const viewport = chatViewport();
  expect(viewport.scrollHeight).toBe(viewport.clientHeight);
  expect(viewport.scrollTop).toBe(0);
  sendUpwardInput(viewport, 'wheel');
  await settleScroll();
  emit('The reply now fills the viewport.\n\n'.repeat(30));
  await expect
    .poll(() => viewport.scrollHeight)
    .toBeGreaterThan(viewport.clientHeight + 500);
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  // Once scrolling is possible, actual upward movement must pause follow.
  sendUpwardInput(viewport, 'wheel');
  viewport.scrollTop -= 200;
  const readingTop = viewport.scrollTop;
  emit('More output while reading history.\n\n'.repeat(20));
  await expect
    .poll(() => viewport.textContent)
    .toContain('More output while reading history.');
  await settleScroll();
  expect(viewport.scrollTop).toBe(readingTop);
  expect(bottomGap()).toBeGreaterThan(500);
});

async function mountNestedStreamingChat() {
  const { screen, emit } = await mountStreamingChat('nested');
  await screen.getByRole('button', { name: 'Thinking', exact: true }).click();
  const nested = document.querySelector<HTMLDivElement>(
    '[class*="stepBodyText"]',
  )!;
  await expect
    .poll(
      () =>
        nested.clientHeight > 0 && nested.scrollHeight > nested.clientHeight,
    )
    .toBe(true);
  // Wait for expansion to finish before measuring either scroll position.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  return { nested, viewport: chatViewport(), emit };
}

test('keeps following while upward scrolling is consumed by nested content', async () => {
  const { nested, viewport, emit } = await mountNestedStreamingChat();
  nested.scrollTop = 400;
  await settleScroll();
  sendUpwardInput(nested, 'wheel');
  nested.scrollTop -= 200;
  emit('Output after nested reading.\n\n'.repeat(6));
  await expect
    .poll(() => viewport.textContent)
    .toContain('Output after nested reading.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  // At the inner boundary an upward gesture may move the transcript.
  // Preserve that movement even before its asynchronous scroll event.
  nested.scrollTop = 0;
  await settleScroll();
  sendUpwardInput(nested, 'wheel');
  viewport.scrollTop -= 200;
  const readingTop = viewport.scrollTop;
  emit('Output after reaching the boundary.\n\n'.repeat(20));
  await expect
    .poll(() => viewport.textContent)
    .toContain('Output after reaching the boundary.');
  await settleScroll();
  expect(viewport.scrollTop).toBe(readingTop);
  expect(bottomGap()).toBeGreaterThan(500);
});

test('keeps following when a nested upward gesture moves neither container', async () => {
  const { nested, viewport, emit } = await mountNestedStreamingChat();
  nested.scrollTop = 0;
  sendUpwardInput(nested, 'touch');
  emit('Output after an unmoving gesture.\n\n'.repeat(20));
  await expect
    .poll(() => viewport.textContent)
    .toContain('Output after an unmoving gesture.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
});
