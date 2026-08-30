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
      workflows: [{ alias: 'daily-report', workflow: 'daily-report' }],
    }),
  }),
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
    path: '/workflows/$workflowId',
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
    .element(screen.getByRole('link', { name: 'daily-report' }))
    .toHaveAttribute('href', '/workflow/daily-report');
});
