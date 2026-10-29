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
  const screen = await render(<RouterProvider router={router as never} />);
  return Object.assign(screen, { queryClient, router });
}

beforeEach(() => {
  fixture.read.mockReset().mockResolvedValue(empty);
  fixture.list
    .mockReset()
    .mockResolvedValue([{ id: 'test', autoRefreshSeconds: 0 }]);
});
afterEach(() => vi.unstubAllGlobals());

test('the native host drives refresh and opens Apps outside the canvas router', async () => {
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
  expect(fixture.list).not.toHaveBeenCalled();
  expect(screen.queryClient.getQueryState(['dashboards'])).toBeUndefined();
  expect(document.querySelector('[data-editing]')).toBeNull();
  await expect
    .element(document.querySelector('.react-resizable-handle') as HTMLElement)
    .not.toBeVisible();
  expect(document.querySelector('nav')).toBeNull();
  // No metadata request or web timer: the native host owns scheduling.
  await expect
    .element(screen.getByRole('main', { name: 'Dashboard canvas' }))
    .toBeVisible();
  await expect.poll(widgetText).toBe('Refresh 0');
  expect(
    document.querySelector('button[aria-label="Refresh dashboard"]'),
  ).toBeNull();
  expect(
    document.querySelector('button[aria-label="Refresh widget"]'),
  ).toBeNull();
  window.dispatchEvent(
    new CustomEvent('hatch:dashboard-refresh', {
      detail: { dashboardId: 'other' },
    }),
  );
  expect(fixture.read).toHaveBeenCalledOnce();
  window.dispatchEvent(
    new CustomEvent('hatch:dashboard-refresh', {
      detail: { dashboardId: 'test' },
    }),
  );
  await expect.poll(widgetText).toBe('Refresh 1');
  expect(fixture.read).toHaveBeenCalledTimes(2);
  expect(fixture.list).not.toHaveBeenCalled();
  // Open app must reach the WebView as a load request the host intercepts; a
  // router transition would move history and race the host's recovery.
  let routed: boolean | undefined;
  const intercept = (event: MouseEvent) => {
    routed = event.defaultPrevented;
    event.preventDefault();
  };
  window.addEventListener('click', intercept);
  (
    screen.getByRole('link', { name: 'Open app' }).element() as HTMLElement
  ).click();
  window.removeEventListener('click', intercept);
  expect(routed).toBe(false);
  expect(screen.router.state.location.pathname).toBe('/');
});

test('recovers from an unavailable dashboard through retry and keeps the empty canvas usable', async () => {
  fixture.read.mockRejectedValueOnce(new Error('Dashboard not found'));
  const screen = await mount();
  await expect.element(screen.getByRole('alert')).toBeVisible();
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect
    .element(screen.getByRole('main', { name: 'Dashboard canvas' }))
    .toBeVisible();
  expect(
    document.querySelector('button[aria-label="Refresh dashboard"]'),
  ).toBeNull();
  expect(document.querySelector('iframe')).toBeNull();
  expect(document.querySelector('[data-editing]')).toBeNull();
});
