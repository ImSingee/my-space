import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

// Keep the enabled Workflow component behavior covered while the product-level
// capability switch hides it in production.
vi.mock('~/features', () => ({ WORKFLOWS_ENABLED: true }));

type AppFixture = {
  id: string;
  slug: string;
  name: string;
  description: null;
  status: 'deployed';
  capabilities: {
    database: boolean;
    frontend: boolean;
    widgets: boolean;
    backend: boolean;
    cron: boolean;
    webhook: boolean;
    kv: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

type PinFixture = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  entryHash: string | null;
  status: 'deployed';
};

type WorkflowFixture = {
  id: string;
  name: string;
  description: null;
  status: 'deployed';
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

const fixtures = vi.hoisted(() => ({
  apps: [] as AppFixture[],
  pins: [] as PinFixture[],
  workflows: [] as WorkflowFixture[],
  pinsPending: false,
  workflowsPending: false,
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: {
    queryKey: ['test-apps'],
    queryFn: async () => fixtures.apps,
  },
  normalizedManifestQueryOptions: (appId: string) => ({
    queryKey: ['test-app-manifest', appId],
    queryFn: async () => ({ app: { routes: [] } }),
  }),
}));

vi.mock('~queries/sidebar', () => ({
  sidebarItemsQueryOptions: {
    queryKey: ['test-sidebar-items'],
    queryFn: () =>
      fixtures.pinsPending
        ? new Promise<never>(() => {})
        : Promise.resolve(fixtures.pins),
  },
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: () =>
      fixtures.workflowsPending
        ? new Promise<never>(() => {})
        : Promise.resolve(fixtures.workflows),
  },
}));

vi.mock('~server/sidebar', () => ({
  addSidebarItem: async () => undefined,
  removeSidebarItem: async () => undefined,
  reorderSidebarItems: async () => undefined,
  setSidebarPin: async () => undefined,
  updateSidebarItem: async () => undefined,
}));

vi.mock('~server/workflows', () => ({
  setWorkflowPinFn: async () => undefined,
}));

const capabilities = {
  database: false,
  frontend: true,
  widgets: false,
  backend: false,
  cron: false,
  webhook: false,
  kv: false,
};

function app(id: string, slug = `slug-${id}`): AppFixture {
  return {
    id,
    slug,
    name: `App ${id}`,
    description: null,
    status: 'deployed',
    capabilities,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function pin(
  id: string,
  appId: string,
  appSlug = `slug-${appId}`,
  entryHash: string | null = null,
  label = `Pinned ${appId}`,
): PinFixture {
  return {
    id,
    appId,
    appSlug,
    label,
    entryHash,
    status: 'deployed',
  };
}

function workflow(id: string, pinned: boolean): WorkflowFixture {
  return {
    id,
    name: `Workflow ${id}`,
    description: null,
    status: 'deployed',
    pinned,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

async function renderSections(initialEntry = '/') {
  const [{ PinnedApps }, { PinnedWorkflows }] = await Promise.all([
    import('./pinned-apps'),
    import('./pinned-workflows'),
  ]);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <PinnedApps />
        <PinnedWorkflows />
      </>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  });
  const agentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/agent',
    component: () => null,
  });
  const appsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/apps',
    component: () => null,
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/$appSlug',
    component: () => null,
  });
  const appManageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/$appSlug/manage',
    component: () => null,
  });
  const workflowsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows',
    component: () => null,
  });
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$workflowId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      agentRoute,
      appsRoute,
      appRoute,
      appManageRoute,
      workflowsRoute,
      workflowRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { queryClient, router, screen };
}

beforeEach(() => {
  fixtures.apps = [];
  fixtures.pins = [];
  fixtures.workflows = [];
  fixtures.pinsPending = false;
  fixtures.workflowsPending = false;
});

test('hides empty app and workflow sections even when unpinned entities exist', async () => {
  fixtures.apps = [app('available')];
  fixtures.workflows = [workflow('available', false)];

  const { screen } = await renderSections();

  await expect
    .element(screen.getByText('Apps', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .not.toBeInTheDocument();
  expect(
    screen.container.querySelector('[aria-label="Manage apps"]'),
  ).toBeNull();
  expect(screen.container.querySelector('[aria-label="Add app"]')).toBeNull();
  expect(
    screen.container.querySelector('[aria-label="Manage workflows"]'),
  ).toBeNull();
  expect(
    screen.container.querySelector('[aria-label="Add workflow"]'),
  ).toBeNull();
});

test('uses the app slug for links and hash-aware active state', async () => {
  fixtures.apps = [app('01k-app', 'todo')];
  fixtures.pins = [
    pin('pin-root', '01k-app', 'todo', null, 'Todo home'),
    pin('pin-settings', '01k-app', 'todo', 'settings', 'Todo settings'),
  ];

  const { screen } = await renderSections('/app/todo#settings');

  const home = screen.getByRole('link', { name: 'Todo home' });
  const settings = screen.getByRole('link', { name: 'Todo settings' });
  await expect.element(home).toHaveAttribute('href', '/app/todo');
  await expect.element(settings).toHaveAttribute('href', '/app/todo#settings');
  expect(home.element()).not.toHaveAttribute('data-active');
  expect(settings.element()).toHaveAttribute('data-active', 'true');
});

test('opens an app management page from the menu after Unpin', async () => {
  fixtures.apps = [app('01k-app', 'todo')];
  fixtures.pins = [
    pin('pin-settings', '01k-app', 'todo', 'settings', 'Todo settings'),
  ];

  const { router, screen } = await renderSections('/app/todo#settings');

  await screen.getByRole('button', { name: 'Options' }).click();
  const edit = screen.getByRole('menuitem', { name: 'Edit' });
  const unpin = screen.getByRole('menuitem', { name: 'Unpin' });
  const manage = screen.getByRole('menuitem', { name: 'Manage' });

  await expect.element(edit).toBeVisible();
  await expect.element(unpin).toBeVisible();
  await expect.element(manage).toHaveAttribute('href', '/app/todo/manage');
  expect(
    unpin.element().compareDocumentPosition(manage.element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();

  await manage.click();
  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe('/app/todo/manage');
    expect(router.state.location.hash).toBe('');
  });
});

test('keeps both sections hidden while their pin queries are unresolved', async () => {
  fixtures.apps = [app('available')];
  fixtures.pinsPending = true;
  fixtures.workflowsPending = true;

  const { screen } = await renderSections();

  await expect
    .element(screen.getByText('Apps', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .not.toBeInTheDocument();
});

test('hides each section when its last cached pin is removed', async () => {
  fixtures.apps = [app('one')];
  fixtures.pins = [pin('pin-one', 'one')];
  fixtures.workflows = [workflow('one', true)];

  const { queryClient, screen } = await renderSections();
  await expect.element(screen.getByText('Apps', { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .toBeVisible();

  queryClient.setQueryData(['test-sidebar-items'], []);
  await expect
    .element(screen.getByText('Apps', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .toBeVisible();

  queryClient.setQueryData(['test-workflows'], [workflow('one', false)]);
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .not.toBeInTheDocument();
});
