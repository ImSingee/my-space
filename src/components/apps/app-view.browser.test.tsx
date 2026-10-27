import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type AnyRootRoute,
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';
import type { AppDetail } from '~server/apps';
import { appTheme } from '~/ui/theme';

const mocks = vi.hoisted(() => ({
  app: null as AppDetail | null,
  pendingRevision: null as string | null,
  getAppBySlug: vi.fn<(input: { data: string }) => Promise<AppDetail | null>>(),
  rootRoute: null as AnyRootRoute | null,
  toastError: vi.fn<(message: string) => void>(),
}));

// Mount the real route module on a real router so loaders, reloads and error
// boundaries behave as in the app; only the file-route registration differs.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  const { createElement } = await import('react');
  const rootRoute = actual.createRootRouteWithContext<{
    queryClient: QueryClient;
  }>()({
    component: () =>
      createElement(
        'div',
        null,
        createElement('nav', null, 'App shell'),
        createElement(actual.Outlet),
      ),
  });
  mocks.rootRoute = rootRoute;
  return {
    ...actual,
    createFileRoute: () => (options: object) =>
      actual.createRoute({
        ...options,
        getParentRoute: () => rootRoute,
        path: '/app/$appSlug',
      }),
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

vi.mock('~server/apps', () => {
  const unused = vi.fn<() => void>();
  return {
    getAppBySlug: mocks.getAppBySlug,
    getAppDeploymentRevision: unused,
    getAppOps: unused,
    getDeploymentBuildLog: unused,
    getNormalizedManifest: unused,
    inspectAppDataTablesFn: unused,
    listAppBackendsFn: unused,
    listAppKvFn: unused,
    listApps: unused,
    listCronRunsFn: unused,
    listDeployments: unused,
  };
});

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}));

import { Route } from '~/routes/_app/app/$appSlug';

const frontendCapabilities = {
  database: false,
  frontend: true,
  widgets: false,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
  dataTable: false,
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
    compatibility: {
      version: 2,
      latestVersion: 2,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    },
    currentSourceCommit: null,
    dbName: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

async function renderAppView(initialEntry = '/app/app-one') {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree: mocks.rootRoute!.addChildren([Route]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: { queryClient },
  });
  const screen = await render(
    <MantineProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await expect.element(screen.getByText('App shell')).toBeVisible();
  await expect.element(screen.getByText('Example app')).toBeVisible();
  return { screen, router };
}

type Screen = Awaited<ReturnType<typeof renderAppView>>['screen'];

/** Wait until the app's own document is loaded and the view is listening. */
async function loadedFrame(screen: Screen, slug: string) {
  let win: Window | null = null;
  await vi.waitFor(() => {
    const frame = screen.container.querySelector('iframe');
    expect(frame).toHaveAttribute('src', `/app/${slug}/embed/`);
    expect(frame?.contentWindow?.location.pathname).toBe(`/app/${slug}/embed/`);
    expect(frame?.contentDocument?.readyState).toBe('complete');
    expect(screen.container.querySelector('.mantine-Loader-root')).toBeNull();
    win = frame?.contentWindow ?? null;
  });
  return win!;
}

/** Serve a distinct app per slug, as the real lookup does. */
function serveAppsBySlug() {
  mocks.getAppBySlug.mockImplementation(async ({ data: slug }) =>
    app({ id: slug, slug }),
  );
}

/** Serve the current fixture for every fetch after the initial load. */
function serveApp(next: Partial<AppDetail>) {
  mocks.getAppBySlug.mockImplementation(async () => {
    mocks.app = app(next);
    return mocks.app;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.app = app();
  mocks.pendingRevision = null;
  mocks.getAppBySlug.mockImplementation(async () => mocks.app);
});

test('marks an update and remounts the iframe only after reload', async () => {
  mocks.pendingRevision = 'revision-two';
  const { screen } = await renderAppView();
  serveApp({ deploymentRevision: 'revision-two' });
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

  await vi.waitFor(() => expect(mocks.getAppBySlug).toHaveBeenCalledTimes(2));
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

test('replaces an unsupported frontend with an Agent update state', async () => {
  mocks.app = app({
    compatibility: {
      version: 0,
      latestVersion: 2,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const { screen } = await renderAppView();

  expect(screen.container.querySelector('iframe')).toBeNull();
  await expect
    .element(screen.getByRole('link', { name: 'Open Agent' }))
    .toBeVisible();
});

test('directs a newer frontend deployment to a platform update', async () => {
  mocks.app = app({
    compatibility: {
      version: LATEST_APP_COMPATIBILITY_VERSION + 1,
      latestVersion: LATEST_APP_COMPATIBILITY_VERSION,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const { screen } = await renderAppView();

  expect(screen.container.querySelector('iframe')).toBeNull();
  await expect
    .element(screen.getByText('Platform update required'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Manage app' }))
    .toBeVisible();
});

test('offers reload for a first deployment and opens its frontend', async () => {
  mocks.app = app({
    status: 'draft',
    capabilities: null,
    deploymentRevision: null,
  });
  mocks.pendingRevision = 'revision-one';
  const { screen } = await renderAppView();
  serveApp({});

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
  const { screen } = await renderAppView();
  serveApp({
    capabilities: { ...frontendCapabilities, frontend: false, backend: true },
    deploymentRevision: 'revision-two',
  });
  expect(screen.container.querySelector('iframe')).toBeTruthy();

  await screen
    .getByRole('button', { name: 'Update available — reload app' })
    .click();

  await expect.element(screen.getByText('Backend-only app')).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBeNull();
});

test('keeps the app view and its running iframe when a reload request fails', async () => {
  const failure = new Error('Failed to fetch');
  const { screen } = await renderAppView();
  mocks.getAppBySlug.mockRejectedValueOnce(failure);
  const originalFrame = screen.container.querySelector('iframe');

  await screen.getByRole('button', { name: 'Reload app' }).click();

  await vi.waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith(failure.message),
  );
  await expect.element(screen.getByText('App shell')).toBeVisible();
  await expect.element(screen.getByText('Example app')).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBe(originalFrame);
  await expect
    .element(screen.getByRole('button', { name: 'Reload app' }))
    .toBeEnabled();
});

test('shows not found when the app is gone on reload', async () => {
  const { screen } = await renderAppView();
  mocks.getAppBySlug.mockResolvedValue(null);

  await screen.getByRole('button', { name: 'Reload app' }).click();

  await expect.element(screen.getByText('Not Found')).toBeVisible();
  expect(screen.container.querySelector('iframe')).toBeNull();
});

test('hands a pending update reload to the plain icon and restores the prompt on failure', async () => {
  mocks.pendingRevision = 'revision-two';
  const { screen } = await renderAppView();
  let rejectReload: (error: Error) => void = () => undefined;
  mocks.getAppBySlug.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectReload = reject;
      }),
  );

  await screen
    .getByRole('button', { name: 'Update available — reload app' })
    .click();

  await vi.waitFor(() =>
    expect(screen.container.querySelector('output')).toBeNull(),
  );
  await expect
    .element(
      screen.getByRole('button', { name: 'Update available — reload app' }),
    )
    .toBeDisabled();

  rejectReload(new Error('Revision lookup failed'));

  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent('Update available');
  await expect
    .element(
      screen.getByRole('button', { name: 'Update available — reload app' }),
    )
    .toBeEnabled();
});

test('mirrors in-app history navigation to the host URL', async () => {
  const { screen, router } = await renderAppView();
  const win = await loadedFrame(screen, 'app-one');

  // Hash routers navigate with pushState, which fires no `hashchange`.
  win.history.pushState(null, '', '#/orders');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/orders'));

  win.history.replaceState(null, '', '#/orders/42');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/orders/42'));
  expect(router.state.location.pathname).toBe('/app/app-one');
});

test('opens another app at its own entry point, not the previous page', async () => {
  serveAppsBySlug();
  const { screen, router } = await renderAppView();
  const first = await loadedFrame(screen, 'app-one');
  first.history.pushState(null, '', '#/orders');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/orders'));

  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'app-two' },
  });
  const second = await loadedFrame(screen, 'app-two');
  expect(second.location.hash).toBe('');
  expect(router.state.location.hash).toBe('');

  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'app-one' },
    hash: '/settings',
  });
  const reopened = await loadedFrame(screen, 'app-one');
  expect(reopened.location.hash).toBe('#/settings');
  expect(router.state.location.hash).toBe('/settings');
});

test('returns the open app to the selected entry point', async () => {
  const { screen, router } = await renderAppView();
  const win = await loadedFrame(screen, 'app-one');
  const frame = screen.container.querySelector('iframe');

  win.history.pushState(null, '', '#/orders');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/orders'));
  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'app-one' },
  });
  await vi.waitFor(() => expect(win.location.hash).toBe(''));
  expect(router.state.location.hash).toBe('');

  win.history.pushState(null, '', '#/orders');
  await vi.waitFor(() => expect(router.state.location.hash).toBe('/orders'));
  await router.navigate({
    to: '/app/$appSlug',
    params: { appSlug: 'app-one' },
    hash: '/settings',
  });
  await vi.waitFor(() => expect(win.location.hash).toBe('#/settings'));
  expect(router.state.location.hash).toBe('/settings');
  // The app stays loaded; only its page changes.
  expect(screen.container.querySelector('iframe')).toBe(frame);
});

test('keeps percent escapes when moving hashes between URLs', async () => {
  // `a%2520b` names the id `a%20b`; decoding once would retarget `a b`.
  const { screen, router } = await renderAppView('/app/app-one#/files/a%2520b');
  const win = await loadedFrame(screen, 'app-one');
  expect(win.location.hash).toBe('#/files/a%2520b');

  win.history.pushState(null, '', '#/files/c%2520d');
  await vi.waitFor(() =>
    expect(router.state.location.href).toBe('/app/app-one#/files/c%2520d'),
  );
});
