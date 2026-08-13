import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppOps } from '~server/apps';
import { OperationsPanel } from './index';

const fixtures = vi.hoisted(() => ({
  ops: null as AppOps | null,
}));

vi.mock('~queries/apps', () => ({
  appBackendsQueryOptions: {
    queryKey: ['test-app-backends'],
    queryFn: async () => [],
  },
  appDataTablesQueryOptions: (id: string) => ({
    queryKey: ['test-app-data-tables', id],
    queryFn: async () => null,
  }),
  appKvQueryOptions: (id: string) => ({
    queryKey: ['test-app-kv', id],
    queryFn: async () => [],
  }),
  appOpsQueryOptions: (id: string) => ({
    queryKey: ['test-app-ops', id],
    queryFn: async () => fixtures.ops,
  }),
  cronRunsQueryOptions: (id: string) => ({
    queryKey: ['test-cron-runs', id],
    queryFn: async () => [],
  }),
}));

vi.mock('~server/apps', () => {
  const notCalled = () => {
    throw new Error('Unexpected server function call.');
  };

  return {
    deleteAppKvFn: notCalled,
    mutateAppDataTableFn: notCalled,
    queryAppDataTableFn: notCalled,
    restartAppBackendFn: notCalled,
    runCronJobFn: notCalled,
    setAppKvFn: notCalled,
    startAppBackendFn: notCalled,
    stopAppBackendFn: notCalled,
  };
});

function appOps(storageEnabled: boolean): AppOps {
  return {
    backend: { capable: false, mode: null },
    cron: { enabled: false, jobs: [] },
    webhook: {
      enabled: false,
      url: null,
      secret: null,
      auth: 'platform',
    },
    storage: { enabled: storageEnabled },
    kv: { enabled: false },
    dataTable: { enabled: false, dbName: null, schemaHash: null },
  };
}

async function renderPanel(ops: AppOps) {
  fixtures.ops = ops;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <OperationsPanel appId="app-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

test('describes the enabled persistent backend directory and its lifecycle', async () => {
  const screen = await renderPanel(appOps(true));

  await expect.element(screen.getByText('Persistent storage')).toBeVisible();
  await expect
    .element(screen.getByText(/available through STORAGE_DIR/))
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        /Files survive restarts, deployments, and rollbacks, and are deleted with the app/,
      ),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText(/Disabling storage keeps the files but revokes access/),
    )
    .toBeVisible();
});

test('hides persistent storage when the capability is disabled', async () => {
  const screen = await renderPanel(appOps(false));

  await expect
    .element(
      screen.getByText(
        /No database, Data Tables, persistent storage, backend, scheduled jobs/,
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText('Persistent storage', { exact: true }))
    .not.toBeInTheDocument();
});
