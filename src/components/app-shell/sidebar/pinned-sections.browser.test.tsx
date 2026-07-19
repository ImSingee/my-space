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
    storage: boolean;
    kv: boolean;
    userscripts: boolean;
  };
  createdAt: string;
  updatedAt: string;
};

type PinFixture = {
  id: string;
  appId: string;
  label: string;
  entryHash: null;
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
  storage: false,
  kv: false,
  userscripts: false,
};

function app(id: string): AppFixture {
  return {
    id,
    slug: id,
    name: `App ${id}`,
    description: null,
    status: 'deployed',
    capabilities,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

function pin(id: string, appId: string): PinFixture {
  return {
    id,
    appId,
    label: `Pinned ${appId}`,
    entryHash: null,
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

async function renderSections() {
  const [{ PinnedApps }, { PinnedWorkflows }] = await Promise.all([
    import('./pinned-apps'),
    import('./pinned-workflows'),
  ]);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <>
        <PinnedApps />
        <PinnedWorkflows />
      </>
    ),
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
    path: '/apps/$appId',
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
      workflowsRoute,
      workflowRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { queryClient, screen };
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

test('shows only the app section when only an app is pinned', async () => {
  fixtures.apps = [app('one')];
  fixtures.pins = [pin('pin-one', 'one')];
  fixtures.workflows = [workflow('one', false)];

  const { screen } = await renderSections();

  await expect.element(screen.getByText('Apps', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('Pinned one')).toBeVisible();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .not.toBeInTheDocument();
});

test('shows only the workflow section when only a workflow is pinned', async () => {
  fixtures.apps = [app('one')];
  fixtures.workflows = [workflow('one', true)];

  const { screen } = await renderSections();

  await expect
    .element(screen.getByText('Apps', { exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Workflows', { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText('Workflow one')).toBeVisible();
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
