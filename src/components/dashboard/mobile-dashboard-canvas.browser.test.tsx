import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { DashboardData } from '~server/dashboards';
import { MobileDashboardCanvas } from './mobile-dashboard-canvas';

const fixture = vi.hoisted(() => ({
  read: vi.fn<() => Promise<DashboardData>>(),
  list: vi.fn<() => Promise<{ id: string; autoRefreshSeconds: number }[]>>(),
}));
vi.mock('~queries/dashboards', () => ({
  dashboardQueryOptions: (id: string) => ({
    queryKey: ['dashboard', id],
    queryFn: fixture.read,
  }),
  dashboardsQueryOptions: { queryKey: ['dashboards'], queryFn: fixture.list },
}));
const empty: DashboardData = {
  revision: 0,
  widgets: [],
  layouts: { desktop: [], tablet: [], mobile: [] },
};

async function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <MantineProvider>
        <QueryClientProvider client={queryClient}>
          <div style={{ width: 390 }}>
            <MobileDashboardCanvas dashboardId="test" />
          </div>
        </QueryClientProvider>
      </MantineProvider>
    ),
  });
  const app = createRoute({
    getParentRoute: () => root,
    path: '/app/$appSlug',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([route, app]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router as never} />);
}

beforeEach(() => {
  fixture.read.mockReset().mockResolvedValue(empty);
  fixture.list
    .mockReset()
    .mockResolvedValue([{ id: 'test', autoRefreshSeconds: 0 }]);
});
afterEach(() => vi.unstubAllGlobals());

test('renders a real widget and refreshes it while keeping layout editing disabled', async () => {
  const item = {
    id: 'placement',
    appId: 'app',
    appSlug: 'app',
    appName: 'App',
    widgetId: 'widget',
    name: 'Widget',
    url: '/fixture.js',
    sortOrder: 0,
    defaultSize: { w: 4, h: 3 },
    supportedSizes: [],
  };
  const geometry = [{ id: item.id, x: 0, y: 0, w: 4, h: 3 }];
  fixture.read.mockResolvedValue({
    revision: 0,
    widgets: [item],
    layouts: { desktop: geometry, tablet: geometry, mobile: geometry },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          `export function mount(el, ctx) { let n=0; el.textContent='Refresh '+n; ctx.onRefresh(() => { el.textContent='Refresh '+(++n); }); }`,
        ),
    ),
  );
  const screen = await mount();
  const widgetText = () =>
    document
      .querySelector('iframe')
      ?.contentDocument?.getElementById('hatch-widget-root')?.textContent;
  await expect.poll(widgetText).toBe('Refresh 0');
  expect(document.querySelector('[data-editing]')).toBeNull();
  await expect
    .element(document.querySelector('.react-resizable-handle') as HTMLElement)
    .not.toBeVisible();
  expect(document.querySelector('nav')).toBeNull();
  await screen
    .getByRole('button', { name: 'Refresh dashboard', exact: true })
    .click();
  await expect.poll(widgetText).toBe('Refresh 1');
  expect(fixture.read).toHaveBeenCalledTimes(2);
});

test('recovers from an unavailable dashboard through retry and keeps the empty canvas usable', async () => {
  fixture.read.mockRejectedValueOnce(new Error('Dashboard not found'));
  const screen = await mount();
  await expect.element(screen.getByRole('alert')).toBeVisible();
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect
    .element(screen.getByRole('main', { name: 'Dashboard canvas' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Refresh dashboard' }))
    .toBeVisible();
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('[data-editing]')).toBeNull();
});
