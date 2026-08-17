import { MantineProvider } from '@mantine/core';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppDetail } from '~server/apps';
import { appTheme } from '~/ui/theme';

const mocks = vi.hoisted(() => ({
  app: null as AppDetail | null,
  pendingRevision: null as string | null,
  invalidate: vi.fn<() => Promise<void>>(),
  toastError: vi.fn<(message: string) => void>(),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    createFileRoute: () => (options: object) => ({
      ...options,
      useLoaderData: () => mocks.app,
    }),
    Link: ({ children, ...props }: { children: React.ReactNode }) =>
      createElement('a', props, children),
    useRouter: () => ({ invalidate: mocks.invalidate }),
    useRouterState: () => '',
  };
});

vi.mock('~components/apps/use-app-deployment-update', () => ({
  useAppDeploymentUpdate: ({
    deploymentRevision,
  }: {
    deploymentRevision: string | null;
  }) => ({
    pendingRevision: mocks.pendingRevision,
    updateAvailable:
      mocks.pendingRevision !== null &&
      mocks.pendingRevision !== deploymentRevision,
  }),
}));

vi.mock('~server/apps', () => ({
  getAppBySlug: vi.fn<() => void>(),
  getAppDeploymentRevision: vi.fn<() => void>(),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

import { AppView } from '~/routes/_app/app/$appSlug';

const frontendCapabilities = {
  database: false,
  frontend: true,
  widgets: false,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
  dataTable: false,
  userscripts: false,
};

function app(overrides: Partial<AppDetail> = {}): AppDetail {
  return {
    id: 'app-one',
    slug: 'app-one',
    name: 'Example app',
    description: null,
    status: 'deployed',
    capabilities: frontendCapabilities,
    deploymentRevision: 'revision-one',
    currentSourceCommit: null,
    dbName: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

async function renderAppView() {
  return render(
    <MantineProvider theme={appTheme}>
      <AppView />
    </MantineProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app = app();
  mocks.pendingRevision = null;
  mocks.invalidate.mockResolvedValue();
});

test('marks an update and remounts the iframe only after reload', async () => {
  mocks.pendingRevision = 'revision-two';
  mocks.invalidate.mockImplementationOnce(async () => {
    mocks.app = app({ deploymentRevision: 'revision-two' });
  });
  const screen = await renderAppView();
  const originalFrame = screen.container.querySelector('iframe');
  expect(originalFrame).toBeTruthy();
  expect(originalFrame).toHaveAttribute('src', '/app/app-one/embed/');
  await expect
    .element(screen.getByRole('link', { name: 'Open in new tab' }))
    .toHaveAttribute('href', '/app/app-one/embed/');

  const reload = screen.getByRole('button', {
    name: 'Update available — reload app',
  });
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent('Update available');
  await expect.element(reload).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);

  await reload.click();

  await vi.waitFor(() =>
    expect(mocks.invalidate).toHaveBeenCalledWith({
      sync: true,
    }),
  );
  await vi.waitFor(() => {
    const refreshedFrame = screen.container.querySelector('iframe');
    expect(refreshedFrame).toBeTruthy();
    expect(refreshedFrame).not.toBe(originalFrame);
  });
  await expect
    .element(screen.getByRole('button', { name: 'Reload app' }))
    .toBeVisible();
  expect(screen.container.querySelector('output')).toBeNull();
});

test('offers reload for a first deployment and opens its frontend', async () => {
  mocks.app = app({
    status: 'draft',
    capabilities: null,
    deploymentRevision: null,
  });
  mocks.pendingRevision = 'revision-one';
  mocks.invalidate.mockImplementationOnce(async () => {
    mocks.app = app();
  });
  const screen = await renderAppView();

  expect(screen.container.querySelector('iframe')).toBeNull();
  await screen
    .getByRole('button', { name: 'Update available — reload app' })
    .click();

  await vi.waitFor(() =>
    expect(screen.container.querySelector('iframe')).toBeTruthy(),
  );
});

test('removes the iframe when the activated deployment drops its frontend', async () => {
  mocks.pendingRevision = 'revision-two';
  mocks.invalidate.mockImplementationOnce(async () => {
    mocks.app = app({
      capabilities: { ...frontendCapabilities, frontend: false, backend: true },
      deploymentRevision: 'revision-two',
    });
  });
  const screen = await renderAppView();
  expect(screen.container.querySelector('iframe')).toBeTruthy();

  await screen
    .getByRole('button', { name: 'Update available — reload app' })
    .click();

  await expect.element(screen.getByText('Backend-only app')).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBeNull();
});

test('keeps the existing iframe usable when invalidation fails', async () => {
  const failure = new Error('Revision lookup failed');
  mocks.invalidate.mockRejectedValueOnce(failure);
  const screen = await renderAppView();
  const originalFrame = screen.container.querySelector('iframe');

  await screen.getByRole('button', { name: 'Reload app' }).click();

  await vi.waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith(failure.message),
  );
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
  await expect
    .element(screen.getByRole('button', { name: 'Reload app' }))
    .toBeEnabled();
});
