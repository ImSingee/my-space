import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MantineProvider } from '@mantine/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import {
  AgentRunnerPanel,
  type AgentRunnerPanelProps,
} from './agent-runner-panel';
import type { AgentRunnerStatusSnapshot } from '~server/agent-runner-status';

function snapshotFixture(
  overrides: Partial<AgentRunnerStatusSnapshot> = {},
): AgentRunnerStatusSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    state: 'connected',
    summary: {
      connectedRunners: 1,
      activeRuns: 1,
      blockedRuns: 0,
      staleLeases: 0,
      heartbeatIntervalMs: 15_000,
      leaseTtlMs: 90_000,
    },
    runners: [
      {
        runnerId: 'runner-alpha',
        protocolVersion: 1,
        activeRunCount: 1,
        connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
      },
    ],
    activeRuns: [
      {
        runId: 'run-1',
        sessionId: 'session-1',
        sessionTitle: 'Fix the deploy pipeline',
        status: 'running',
        runnerId: 'runner-alpha',
        runnerConnected: true,
        lease: 'live',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
    ...overrides,
  };
}

/**
 * The panel links active runs to their agent chats, so it must render inside
 * a router that knows the /agent/$threadId path.
 */
function renderPanel(props: AgentRunnerPanelProps) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <MantineProvider>
        <AgentRunnerPanel {...props} />
      </MantineProvider>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/agent/$threadId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // The app registers its own router type globally; this throwaway test
  // router can't satisfy it, so erase the generic.
  return render(<RouterProvider router={router as never} />);
}

const noRefresh = () => {};

test('connected: shows state chip, summary, runner row and a link to the chat', async () => {
  const screen = await renderPanel({
    snapshot: snapshotFixture(),
    isLoading: false,
    error: null,
    onRefresh: noRefresh,
  });

  await expect
    .element(screen.getByText('Connected', { exact: true }))
    .toBeVisible();
  // The runner id appears in both the runner table and the active-run row.
  await expect.element(screen.getByText('runner-alpha').first()).toBeVisible();
  await expect.element(screen.getByText('Connected runners')).toBeVisible();

  const chatLink = screen.getByRole('link', {
    name: 'Fix the deploy pipeline',
  });
  await expect.element(chatLink).toBeVisible();
  expect(chatLink.element().getAttribute('href')).toBe('/agent/session-1');
});

test('offline: shows the offline chip and an inline hint instead of a table', async () => {
  const screen = await renderPanel({
    snapshot: snapshotFixture({
      state: 'offline',
      summary: {
        connectedRunners: 0,
        activeRuns: 0,
        blockedRuns: 0,
        staleLeases: 0,
        heartbeatIntervalMs: 15_000,
        leaseTtlMs: 90_000,
      },
      runners: [],
      activeRuns: [],
    }),
    isLoading: false,
    error: null,
    onRefresh: noRefresh,
  });

  await expect.element(screen.getByText('Offline')).toBeVisible();
  await expect
    .element(screen.getByText(/No Agent Runner is connected/))
    .toBeVisible();
  await expect
    .element(
      screen.getByText('No agent runs are running or waiting right now.'),
    )
    .toBeVisible();
});

test('attention: stale leases flip the chip and badge', async () => {
  const base = snapshotFixture();
  const screen = await renderPanel({
    snapshot: snapshotFixture({
      state: 'attention',
      summary: { ...base.summary, staleLeases: 1 },
      activeRuns: [
        { ...base.activeRuns[0], lease: 'expired', runnerConnected: false },
      ],
    }),
    isLoading: false,
    error: null,
    onRefresh: noRefresh,
  });

  await expect.element(screen.getByText('Needs attention')).toBeVisible();
  await expect.element(screen.getByText('Expired')).toBeVisible();
  await expect.element(screen.getByText('offline')).toBeVisible();
});

test('loading: renders the skeleton placeholder', async () => {
  const screen = await renderPanel({
    snapshot: undefined,
    isLoading: true,
    error: null,
    onRefresh: noRefresh,
  });

  await expect
    .element(screen.getByTestId('agent-runner-loading'))
    .toBeInTheDocument();
});

test('failure: shows the error and retries through the refresh action', async () => {
  const onRefresh = vi.fn<() => void>();
  const screen = await renderPanel({
    snapshot: undefined,
    isLoading: false,
    error: new Error('Boom: status probe failed'),
    onRefresh,
  });

  await expect
    .element(screen.getByText("Couldn't load Agent Runner status"))
    .toBeVisible();
  await expect
    .element(screen.getByText('Boom: status probe failed'))
    .toBeVisible();

  await screen.getByRole('button', { name: 'Refresh' }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});
