import { MantineProvider } from '@mantine/core';
import { ModalsProvider, modals } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppOps } from '~server/apps';
import { OperationsPanel } from './index';

const fixtures = vi.hoisted(() => ({
  ops: null as AppOps | null,
  deleteDatabase:
    vi.fn<
      (input: { data: { id: string; dbName: string } }) => Promise<{ ok: true }>
    >(),
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
  deploymentsQueryOptions: (id: string) => ({
    queryKey: ['test-app-deployments', id],
    queryFn: async () => [],
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
    deleteAppDatabaseFn: fixtures.deleteDatabase,
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

function appOps(
  storageEnabled: boolean,
  database: AppOps['database'] = { enabled: false, dbName: null },
): AppOps {
  return {
    backend: { capable: false, mode: null },
    database,
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
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ModalsProvider>
          <OperationsPanel appId="app-1" />
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.deleteDatabase.mockImplementation(async () => {
    if (fixtures.ops) {
      fixtures.ops = {
        ...fixtures.ops,
        database: { enabled: false, dbName: null },
      };
    }
    return { ok: true };
  });
});

afterEach(() => {
  modals.closeAll();
});

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

test('shows an enabled provisioned database without a delete action', async () => {
  const screen = await renderPanel(
    appOps(false, { enabled: true, dbName: 'app_app_1' }),
  );

  await expect
    .element(screen.getByText('Enabled', { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText('app_app_1')).toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: /Delete database/ }))
    .not.toBeInTheDocument();
});

test('shows a disabled retained database with a delete action', async () => {
  const screen = await renderPanel(
    appOps(false, { enabled: false, dbName: 'app_app_1' }),
  );

  await expect
    .element(screen.getByText('Disabled', { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Delete database app_app_1' }))
    .toBeVisible();
});

test('requires the exact database name before permanent deletion', async () => {
  const screen = await renderPanel(
    appOps(false, { enabled: false, dbName: 'app_app_1' }),
  );
  await screen
    .getByRole('button', { name: 'Delete database app_app_1' })
    .click();

  const input = screen.getByRole('textbox', {
    name: 'Type app_app_1 to confirm',
  });
  const submit = screen.getByRole('button', {
    name: 'Delete database',
    exact: true,
  });
  await expect.element(submit).toBeDisabled();
  await input.fill('APP_APP_1');
  await expect.element(submit).toBeDisabled();
  await input.fill('app_app_1');
  await expect.element(submit).toBeEnabled();
});

test('deletes a retained database and hides the row', async () => {
  const screen = await renderPanel(
    appOps(false, { enabled: false, dbName: 'app_app_1' }),
  );
  await screen
    .getByRole('button', { name: 'Delete database app_app_1' })
    .click();
  await screen
    .getByRole('textbox', { name: 'Type app_app_1 to confirm' })
    .fill('app_app_1');
  await screen
    .getByRole('button', { name: 'Delete database', exact: true })
    .click();

  await vi.waitFor(() =>
    expect(fixtures.deleteDatabase).toHaveBeenCalledWith({
      data: { id: 'app-1', dbName: 'app_app_1' },
    }),
  );
  await expect
    .element(screen.getByText('Database', { exact: true }))
    .not.toBeInTheDocument();
});

test('keeps a failed deletion open and allows retrying', async () => {
  fixtures.deleteDatabase
    .mockRejectedValueOnce(new Error('Database is busy'))
    .mockImplementationOnce(async () => {
      if (fixtures.ops) {
        fixtures.ops = {
          ...fixtures.ops,
          database: { enabled: false, dbName: null },
        };
      }
      return { ok: true };
    });
  const screen = await renderPanel(
    appOps(false, { enabled: false, dbName: 'app_app_1' }),
  );
  await screen
    .getByRole('button', { name: 'Delete database app_app_1' })
    .click();
  await screen
    .getByRole('textbox', { name: 'Type app_app_1 to confirm' })
    .fill('app_app_1');
  const submit = screen.getByRole('button', {
    name: 'Delete database',
    exact: true,
  });
  await submit.click();

  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('Database is busy');
  await submit.click();
  await vi.waitFor(() =>
    expect(fixtures.deleteDatabase).toHaveBeenCalledTimes(2),
  );
  await expect
    .element(screen.getByText('Database', { exact: true }))
    .not.toBeInTheDocument();
});
