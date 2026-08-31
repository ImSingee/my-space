import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

vi.mock('~queries/apps', () => ({
  normalizedManifestQueryOptions: (appId: string) => ({
    queryKey: ['test-app-manifest', appId],
    queryFn: async () => ({
      api: null,
      workflows: [
        { alias: 'daily-report', workflow: '01dailyreportid' },
        { alias: 'missing-report', workflow: '01missingreportid' },
      ],
    }),
  }),
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [
      {
        id: '01dailyreportid',
        slug: 'daily-report',
        name: 'Daily report',
        description: null,
        status: 'deployed',
        pinned: true,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  },
}));

test('shows declared Workflow calls independently of Agent beta features', async () => {
  const { ApiPanel } = await import('./api-panel');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => <ApiPanel appId="app-with-workflow" />,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflow/$workflowSlug',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workflowRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );

  await expect
    .element(screen.getByText('Workflow calls', { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: '01dailyreportid' }))
    .toHaveAttribute('href', '/workflow/daily-report');
  await expect
    .element(screen.getByText('01missingreportid', { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: '01missingreportid' }))
    .not.toBeInTheDocument();
});
