import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

const fixtures = vi.hoisted(() => ({ workflowQueryCalls: 0 }));

vi.mock('~queries/apps', () => ({
  normalizedManifestQueryOptions: (appId: string) => ({
    queryKey: ['test-app-manifest', appId],
    queryFn: async () => ({
      api: null,
      workflows: [{ alias: 'daily-report', workflow: 'daily-report' }],
    }),
  }),
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => {
      fixtures.workflowQueryCalls += 1;
      return [
        {
          id: 'daily-report',
          name: 'Daily report',
          description: null,
          status: 'deployed',
          pinned: true,
          createdAt: '2026-08-28T00:00:00.000Z',
          updatedAt: '2026-08-28T00:00:00.000Z',
        },
      ];
    },
  },
}));

vi.mock('~server/workflows', () => ({
  setWorkflowPinFn: async () => undefined,
}));

beforeEach(() => {
  fixtures.workflowQueryCalls = 0;
});

test('hides Workflow entry points without loading the sidebar data', async () => {
  const [{ PinnedWorkflows }, { ApiPanel }] = await Promise.all([
    import('../app-shell/sidebar/pinned-workflows'),
    import('../apps/api-panel'),
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <PinnedWorkflows />
        <ApiPanel appId="app-with-workflow" />
      </QueryClientProvider>
    </MantineProvider>,
  );

  await expect
    .element(screen.getByText('No RPC services declared in the proto.'))
    .toBeVisible();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Workflow calls', { exact: true }))
    .not.toBeInTheDocument();
  expect(fixtures.workflowQueryCalls).toBe(0);
});
