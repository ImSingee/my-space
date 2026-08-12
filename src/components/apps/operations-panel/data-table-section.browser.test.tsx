import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { DataTableSection } from './data-table-section';

type DataTableInfo = {
  schemaHash: string;
  schema: {
    tables: Record<
      string,
      {
        fields: Record<string, { kind: string; optional: boolean }>;
      }
    >;
  };
  tables: Array<{ name: string; rowCount: number }>;
  migrations: [];
};

type QueryRowsInput = {
  data: {
    query: { table: string | null; cursor?: string; limit: number };
  };
};

type QueryRowsResult = {
  items: Array<Record<string, unknown> & { id: string }>;
  cursor: string | null;
  revision: number;
};

type MutationInput = {
  data: {
    id: string;
    mutation: {
      operations: Array<{
        type: string;
        table: string;
        id?: string;
        value?: Record<string, unknown>;
        unset?: string[];
      }>;
    };
  };
};

const fixtures = vi.hoisted(() => ({
  info: null as DataTableInfo | null,
  infoError: null as Error | null,
  rowsError: null as Error | null,
  rows: [] as QueryRowsResult['items'],
}));

const mocks = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<DataTableInfo | null>>(async () => {
    if (fixtures.infoError) throw fixtures.infoError;
    return fixtures.info;
  }),
  queryRows: vi.fn<(input: QueryRowsInput) => Promise<QueryRowsResult>>(
    async (input) => {
      if (fixtures.rowsError) throw fixtures.rowsError;
      const { table, cursor } = input.data.query;
      return {
        items: fixtures.rows,
        cursor: table === 'alpha' && !cursor ? 'alpha-next' : null,
        revision: 1,
      };
    },
  ),
  mutate: vi.fn<
    (input: MutationInput) => Promise<{ results: never[]; revision: number }>
  >(async () => ({ results: [], revision: 1 })),
  closeAllModals: vi.fn<() => void>(),
  openModal: vi.fn<(options: unknown) => void>(),
  openConfirmModal: vi.fn<(options: unknown) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock('@mantine/modals', () => ({
  modals: {
    closeAll: mocks.closeAllModals,
    open: mocks.openModal,
    openConfirmModal: mocks.openConfirmModal,
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock('~queries/apps', () => ({
  appDataTablesQueryOptions: (id: string) => ({
    queryKey: ['test-data-tables', id],
    queryFn: mocks.inspect,
  }),
}));

vi.mock('~server/apps', () => ({
  mutateAppDataTableFn: mocks.mutate,
  queryAppDataTableFn: mocks.queryRows,
}));

function dataTableInfo(...names: string[]): DataTableInfo {
  return {
    schemaHash: 'schema-hash',
    schema: {
      tables: Object.fromEntries(
        names.map((name) => [
          name,
          {
            fields: { title: { kind: 'string', optional: false } },
          },
        ]),
      ),
    },
    tables: names.map((name) => ({ name, rowCount: 0 })),
    migrations: [],
  };
}

async function renderSection(queryClient = new QueryClient()) {
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <DataTableSection appId="app-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { queryClient, screen };
}

async function renderLastModal(queryClient: QueryClient) {
  const options = mocks.openModal.mock.calls.at(-1)?.[0] as
    | { children?: ReactNode }
    | undefined;
  if (!options?.children) throw new Error('Expected a modal to be opened.');
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{options.children}</MantineProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.info = dataTableInfo('alpha', 'beta');
  fixtures.infoError = null;
  fixtures.rowsError = null;
  fixtures.rows = [];
});

test('shows an inspection error and retries instead of claiming no schema', async () => {
  fixtures.infoError = new Error('Data Table inspection failed');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await expect
    .element(screen.getByText('Data Table inspection failed'))
    .toBeVisible();
  await expect
    .element(screen.getByText('No Data Table schema has been deployed.'))
    .not.toBeInTheDocument();

  fixtures.infoError = null;
  await screen.getByRole('button', { name: 'Retry' }).click();
  await expect
    .element(screen.getByRole('combobox', { name: 'Table' }))
    .toBeVisible();
});

test('shows a row-query error and retries instead of claiming the table is empty', async () => {
  fixtures.rowsError = new Error('Data Table row query failed');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await expect
    .element(screen.getByText('Data Table row query failed'))
    .toBeVisible();
  await expect
    .element(screen.getByText('No rows yet.'))
    .not.toBeInTheDocument();

  fixtures.rowsError = null;
  await screen.getByRole('button', { name: 'Retry' }).click();
  await expect.element(screen.getByText('No rows yet.')).toBeVisible();
});

test('resets the selected table and pagination when the schema removes it', async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await vi.waitFor(() => {
    expect(mocks.queryRows).toHaveBeenCalledWith({
      data: {
        id: 'app-1',
        query: { table: 'alpha', cursor: undefined, limit: 50 },
      },
    });
  });
  await screen.getByRole('button', { name: 'Next page' }).click();
  await vi.waitFor(() => {
    expect(mocks.queryRows).toHaveBeenCalledWith({
      data: {
        id: 'app-1',
        query: { table: 'alpha', cursor: 'alpha-next', limit: 50 },
      },
    });
  });

  fixtures.info = dataTableInfo('beta');
  queryClient.setQueryData(['test-data-tables', 'app-1'], fixtures.info);

  await vi.waitFor(() => {
    expect(mocks.queryRows).toHaveBeenCalledWith({
      data: {
        id: 'app-1',
        query: { table: 'beta', cursor: undefined, limit: 50 },
      },
    });
  });
  await expect
    .element(screen.getByRole('button', { name: 'Previous page' }))
    .toBeDisabled();
});

test('patches only fields whose JSON value actually changed', async () => {
  fixtures.info = dataTableInfo('alpha');
  fixtures.rows = [
    {
      id: 'row-1',
      title: 'Original',
      optionalNote: null,
      settings: { enabled: true, labels: ['alpha', 'beta'] },
      priority: 1,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
  ];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await screen.getByRole('button', { name: 'Edit row-1' }).click();
  const modal = await renderLastModal(queryClient);
  await modal.getByRole('textbox', { name: 'Row value' }).fill(
    JSON.stringify(
      {
        settings: { labels: ['alpha', 'beta'], enabled: true },
        optionalNote: null,
        title: 'Changed',
        priority: null,
      },
      null,
      2,
    ),
  );
  await modal.getByRole('button', { name: 'Save' }).click();

  await vi.waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith({
      data: {
        id: 'app-1',
        mutation: {
          operations: [
            {
              type: 'patch',
              table: 'alpha',
              id: 'row-1',
              value: { title: 'Changed', priority: null },
            },
          ],
        },
      },
    });
  });
});

test('unsets optional fields removed from the row editor', async () => {
  fixtures.info = {
    ...dataTableInfo('alpha'),
    schema: {
      tables: {
        alpha: {
          fields: {
            title: { kind: 'string', optional: false },
            optionalNote: { kind: 'string', optional: true },
            settings: { kind: 'json', optional: true },
          },
        },
      },
    },
  };
  fixtures.rows = [
    {
      id: 'row-1',
      title: 'Original',
      optionalNote: 'Clear me',
      settings: { enabled: true },
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
  ];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await screen.getByRole('button', { name: 'Edit row-1' }).click();
  const modal = await renderLastModal(queryClient);
  await modal
    .getByRole('textbox', { name: 'Row value' })
    .fill(JSON.stringify({ title: 'Original' }, null, 2));
  await modal.getByRole('button', { name: 'Save' }).click();

  await vi.waitFor(() => {
    expect(mocks.mutate).toHaveBeenCalledWith({
      data: {
        id: 'app-1',
        mutation: {
          operations: [
            {
              type: 'patch',
              table: 'alpha',
              id: 'row-1',
              value: {},
              unset: ['optionalNote', 'settings'],
            },
          ],
        },
      },
    });
  });
});

test('rejects removing a required field from the row editor', async () => {
  fixtures.info = {
    ...dataTableInfo('alpha'),
    schema: {
      tables: {
        alpha: {
          fields: {
            title: { kind: 'string', optional: false },
            optionalNote: { kind: 'string', optional: true },
          },
        },
      },
    },
  };
  fixtures.rows = [
    {
      id: 'row-1',
      title: 'Original',
      optionalNote: null,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
  ];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await screen.getByRole('button', { name: 'Edit row-1' }).click();
  const modal = await renderLastModal(queryClient);
  await modal
    .getByRole('textbox', { name: 'Row value' })
    .fill(JSON.stringify({ optionalNote: null }, null, 2));
  await modal.getByRole('button', { name: 'Save' }).click();

  await expect
    .element(modal.getByText('Required field "title" cannot be removed.'))
    .toBeVisible();
  expect(mocks.mutate).not.toHaveBeenCalled();
});

test('does not report an update when the row has no changes', async () => {
  fixtures.info = dataTableInfo('alpha');
  fixtures.rows = [
    {
      id: 'row-1',
      title: 'Original',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
  ];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await screen.getByRole('button', { name: 'Edit row-1' }).click();
  const modal = await renderLastModal(queryClient);
  await modal.getByRole('button', { name: 'Save' }).click();

  await expect.element(modal.getByText('No changes to save.')).toBeVisible();
  expect(mocks.mutate).not.toHaveBeenCalled();
});

test('shows the server error when deleting a referenced row fails', async () => {
  fixtures.info = dataTableInfo('alpha');
  fixtures.rows = [{ id: 'row-1', title: 'Referenced row' }];
  mocks.mutate.mockRejectedValueOnce(
    new Error('Cannot delete this row because another row references it.'),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { screen } = await renderSection(queryClient);

  await screen.getByRole('button', { name: 'Delete row-1' }).click();
  const confirmation = mocks.openConfirmModal.mock.calls.at(-1)?.[0] as
    | { onConfirm?: () => void }
    | undefined;
  confirmation?.onConfirm?.();

  await vi.waitFor(() => {
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Cannot delete this row because another row references it.',
    );
  });
  expect(mocks.toastSuccess).not.toHaveBeenCalled();
});
