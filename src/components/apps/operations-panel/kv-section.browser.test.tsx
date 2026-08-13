import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppKvEntryView } from '~server/apps';
import { KvSection } from './kv-section';

const fixtures = vi.hoisted(() => ({
  entries: [] as AppKvEntryView[],
}));

const mocks = vi.hoisted(() => ({
  list: vi.fn<() => Promise<AppKvEntryView[]>>(async () => fixtures.entries),
  set: vi.fn<() => Promise<{ ok: boolean; secret: boolean }>>(async () => ({
    ok: true,
    secret: true,
  })),
  delete: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  closeAllModals: vi.fn<() => void>(),
  openModal: vi.fn<(options: unknown) => void>(),
  openConfirmModal: vi.fn<(options: unknown) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock('@mantine/modals', () => ({
  modals: {
    closeAll: mocks.closeAllModals,
    open: mocks.openModal,
    openConfirmModal: mocks.openConfirmModal,
  },
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess },
}));

vi.mock('~queries/apps', () => ({
  appKvQueryOptions: (id: string) => ({
    queryKey: ['test-app-kv', id],
    queryFn: mocks.list,
  }),
}));

vi.mock('~server/apps', () => ({
  deleteAppKvFn: mocks.delete,
  setAppKvFn: mocks.set,
}));

function provider(children: ReactNode, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

async function renderSection(queryClient = new QueryClient()) {
  const screen = await render(
    provider(<KvSection appId="app-1" />, queryClient),
  );
  return { queryClient, screen };
}

async function renderLastModal(queryClient: QueryClient) {
  const options = mocks.openModal.mock.calls.at(-1)?.[0] as
    | { children?: ReactNode }
    | undefined;
  if (!options?.children) throw new Error('Expected a KV modal to be opened.');
  return render(provider(options.children, queryClient));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.entries = [
    {
      key: 'api-token',
      // The component must obey the secret flag even if an upstream regression
      // accidentally supplies a value.
      value: 'must-not-render',
      secret: true,
      updatedAt: '2026-08-13T00:00:00.000Z',
    },
    {
      key: 'mode',
      value: 'production',
      secret: false,
      updatedAt: '2026-08-13T00:00:00.000Z',
    },
  ];
});

test('masks secret values and describes encrypted-at-rest writes', async () => {
  const { screen } = await renderSection();

  await expect.element(screen.getByText('••••••••')).toBeVisible();
  await expect
    .element(screen.getByText('must-not-render'))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText('production')).toBeVisible();
  await expect
    .element(screen.getByText(/New or overwritten secret values are encrypted/))
    .toBeVisible();
});

test('edits a secret as a blank overwrite-only encrypted value', async () => {
  const { queryClient, screen } = await renderSection();

  await screen.getByRole('button', { name: 'Edit api-token' }).click();
  const modal = await renderLastModal(queryClient);

  await expect
    .element(modal.getByRole('textbox', { name: 'New value' }))
    .toHaveValue('');
  await expect
    .element(
      modal.getByRole('checkbox', {
        name: 'Secret — encrypt and hide the value here (overwrite-only)',
      }),
    )
    .toBeChecked();
  await expect
    .element(modal.getByRole('button', { name: 'Save' }))
    .toBeDisabled();
});
