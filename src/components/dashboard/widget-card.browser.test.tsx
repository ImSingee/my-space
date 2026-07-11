import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useState } from 'react';
import type { DashboardItem } from '~server/dashboards';
import { WidgetCard } from './widget-card';
import { WIDGET_CHANNEL } from './widget-frame';

const UNSUPPORTED_WIDGET = `
export function mount(el) {
  el.textContent = 'unsupported-content';
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    if (event.data?.t === 'emit-stale-capability') {
      parent.postMessage({
        [${JSON.stringify(WIDGET_CHANNEL)}]: 'refresh-capability',
        generation: event.data.generation,
        supported: true,
      }, '*');
      parent.postMessage({ t: 'stale-capability-sent' }, '*');
    } else if (
      event.data?.[${JSON.stringify(WIDGET_CHANNEL)}] === 'refresh'
    ) {
      parent.postMessage({ t: 'unsupported-refresh-received' }, '*');
    }
  });
}`;

const GENERATION_REPORTER_WIDGET = `
export function mount(el, context) {
  el.textContent = 'generation-reporter-content';
  context.onRefresh(() => {});
  window.addEventListener('message', (event) => {
    if (
      event.source === parent &&
      event.data?.[${JSON.stringify(WIDGET_CHANNEL)}] === 'units'
    ) {
      parent.postMessage({
        t: 'generation-observed',
        generation: event.data.generation,
      }, '*');
    }
  });
}`;

function refreshableWidget(label: string): string {
  return `
export function mount(el, context) {
  el.textContent = 'old-${label}';
  const offRefresh = context.onRefresh(() => {
    parent.postMessage({ t: 'refresh-started', label: '${label}' }, '*');
    return new Promise((resolve) => {
      const finish = (event) => {
        if (
          event.source !== parent ||
          event.data?.t !== 'finish-refresh' ||
          event.data?.label !== '${label}'
        ) return;
        window.removeEventListener('message', finish);
        el.textContent = 'new-${label}';
        resolve();
      };
      window.addEventListener('message', finish);
    });
  });
  return () => offRefresh();
}`;
}

function transientCapabilityWidget(label: string): string {
  return `
export function mount(el, context) {
  let pending;
  const refresh = () => {
    parent.postMessage({ t: 'refresh-started', label: '${label}' }, '*');
    return new Promise((resolve) => { pending = resolve; });
  };
  let offRefresh = context.onRefresh(refresh);
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.label !== '${label}') return;
    if (event.data.t === 'drop-refresh-capability') {
      offRefresh();
      parent.postMessage({ t: 'capability-dropped', label: '${label}' }, '*');
    } else if (event.data.t === 'restore-refresh-capability') {
      offRefresh = context.onRefresh(refresh);
      parent.postMessage({ t: 'capability-restored', label: '${label}' }, '*');
    } else if (event.data.t === 'finish-refresh') {
      el.textContent = 'new-${label}';
      pending?.();
      pending = undefined;
    }
  });
  el.textContent = 'old-${label}';
  return () => offRefresh();
}`;
}

function dashboardItem(id: string): DashboardItem {
  return {
    id,
    appId: `app-${id}`,
    appName: `App ${id}`,
    widgetId: `widget-${id}`,
    name: `Widget ${id}`,
    url: `/widgets/${id}.js`,
    x: 0,
    y: 0,
    w: 4,
    h: 3,
    supportedSizes: [],
  };
}

async function renderDashboard(
  items: DashboardItem[],
  bundles: Record<string, string>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const bundle = bundles[url];
      return bundle === undefined
        ? new Response('Not found', { status: 404 })
        : new Response(bundle, {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
          });
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: function DashboardHarness() {
      const [refreshSignal, setRefreshSignal] = useState(0);
      return (
        <MantineProvider>
          <QueryClientProvider client={queryClient}>
            <button
              type="button"
              onClick={() => setRefreshSignal((value) => value + 1)}
            >
              Refresh all test
            </button>
            {items.map((item) => (
              <div key={item.id} style={{ width: 420, height: 280 }}>
                <WidgetCard
                  item={item}
                  refreshSignal={refreshSignal}
                  onRemove={() => {}}
                />
              </div>
            ))}
          </QueryClientProvider>
        </MantineProvider>
      );
    },
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/apps/$appId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, appRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  const screen = await render(<RouterProvider router={router as never} />);
  return Object.assign(screen, { queryClient });
}

function iframeText(iframe: HTMLIFrameElement): string {
  return (
    iframe.contentDocument
      ?.getElementById('hatch-widget-root')
      ?.textContent?.trim() ?? ''
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('widget without onRefresh hides refresh and global refresh does not reload it', async () => {
  const item = dashboardItem('unsupported');
  let refreshRequests = 0;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.t === 'unsupported-refresh-received') refreshRequests += 1;
  };
  window.addEventListener('message', onMessage);

  try {
    const screen = await renderDashboard([item], {
      [item.url]: UNSUPPORTED_WIDGET,
    });
    const iframe = screen.container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    await vi.waitFor(() =>
      expect(iframeText(iframe!)).toBe('unsupported-content'),
    );
    expect(
      screen.container.querySelector('[aria-label="Refresh widget"]'),
    ).toBeNull();

    await screen.getByRole('button', { name: 'Refresh all test' }).click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(refreshRequests).toBe(0);
    expect(iframeText(iframe!)).toBe('unsupported-content');
    expect(
      screen.container.querySelector('[aria-label="Refresh widget"]'),
    ).toBeNull();
  } finally {
    window.removeEventListener('message', onMessage);
  }
});

test('stale capability from a replaced bundle generation is ignored', async () => {
  const item = dashboardItem('generation');
  let oldGeneration: string | undefined;
  let staleCapabilitySent = false;
  const onMessage = (event: MessageEvent) => {
    if (event.data?.t === 'generation-observed') {
      oldGeneration = event.data.generation;
    } else if (event.data?.t === 'stale-capability-sent') {
      staleCapabilitySent = true;
    }
  };
  window.addEventListener('message', onMessage);

  try {
    const screen = await renderDashboard([item], {
      [item.url]: GENERATION_REPORTER_WIDGET,
    });
    const iframe = screen.container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    await vi.waitFor(() => {
      expect(iframeText(iframe!)).toBe('generation-reporter-content');
      expect(oldGeneration).toBeTruthy();
      expect(
        screen.container.querySelector('[aria-label="Refresh widget"]'),
      ).toBeTruthy();
    });

    screen.queryClient.setQueryData(
      ['widget-bundle', item.url],
      UNSUPPORTED_WIDGET,
    );
    await vi.waitFor(() => {
      expect(iframeText(iframe!)).toBe('unsupported-content');
      expect(
        screen.container.querySelector('[aria-label="Refresh widget"]'),
      ).toBeNull();
    });

    iframe!.contentWindow?.postMessage(
      { t: 'emit-stale-capability', generation: oldGeneration },
      '*',
    );
    await vi.waitFor(() => expect(staleCapabilitySent).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.container.querySelector('[aria-label="Refresh widget"]'),
    ).toBeNull();
  } finally {
    window.removeEventListener('message', onMessage);
  }
});

test('single refresh keeps old content visible and deduplicates every trigger', async () => {
  const item = dashboardItem('single');
  const starts: string[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.t === 'refresh-started') starts.push(event.data.label);
  };
  window.addEventListener('message', onMessage);

  try {
    const screen = await renderDashboard([item], {
      [item.url]: refreshableWidget('single'),
    });
    const iframe = screen.container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    await vi.waitFor(() => expect(iframeText(iframe!)).toBe('old-single'));

    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('[aria-label="Refresh widget"]'),
      ).toHaveLength(1),
    );
    const refresh = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh widget"]',
    );
    expect(refresh).toBeTruthy();
    refresh!.click();

    await vi.waitFor(() => {
      expect(starts).toEqual(['single']);
      expect(refresh!.getAttribute('aria-busy')).toBe('true');
    });
    expect(iframeText(iframe!)).toBe('old-single');

    refresh!.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(starts).toEqual(['single']);

    // Manual refresh-all and auto-refresh both arrive as a new dashboard
    // signal. Neither may overlap the already pending per-widget refresh.
    await screen.getByRole('button', { name: 'Refresh all test' }).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(starts).toEqual(['single']);

    iframe!.contentWindow?.postMessage(
      { t: 'finish-refresh', label: 'single' },
      '*',
    );
    await vi.waitFor(() => {
      expect(iframeText(iframe!)).toBe('new-single');
      expect(refresh!.getAttribute('aria-busy')).not.toBe('true');
    });
  } finally {
    window.removeEventListener('message', onMessage);
  }
});

test('global refresh tracks each refreshable widget independently', async () => {
  const first = dashboardItem('first');
  const second = dashboardItem('second');
  const screen = await renderDashboard([first, second], {
    [first.url]: refreshableWidget('first'),
    [second.url]: refreshableWidget('second'),
  });

  await vi.waitFor(() =>
    expect(
      screen.container.querySelectorAll('[aria-label="Refresh widget"]'),
    ).toHaveLength(2),
  );
  const iframes = screen.container.querySelectorAll('iframe');
  await vi.waitFor(() => {
    expect(iframeText(iframes[0])).toBe('old-first');
    expect(iframeText(iframes[1])).toBe('old-second');
  });

  await screen.getByRole('button', { name: 'Refresh all test' }).click();
  const refreshButtons = screen.container.querySelectorAll<HTMLButtonElement>(
    '[aria-label="Refresh widget"]',
  );
  await vi.waitFor(() => {
    expect(refreshButtons[0].getAttribute('aria-busy')).toBe('true');
    expect(refreshButtons[1].getAttribute('aria-busy')).toBe('true');
  });
  expect(iframeText(iframes[0])).toBe('old-first');
  expect(iframeText(iframes[1])).toBe('old-second');

  iframes[0].contentWindow?.postMessage(
    { t: 'finish-refresh', label: 'first' },
    '*',
  );
  await vi.waitFor(() => {
    expect(refreshButtons[0].getAttribute('aria-busy')).not.toBe('true');
    expect(refreshButtons[1].getAttribute('aria-busy')).toBe('true');
  });

  iframes[1].contentWindow?.postMessage(
    { t: 'finish-refresh', label: 'second' },
    '*',
  );
  await vi.waitFor(() => {
    expect(refreshButtons[1].getAttribute('aria-busy')).not.toBe('true');
    expect(iframeText(iframes[0])).toBe('new-first');
    expect(iframeText(iframes[1])).toBe('new-second');
  });
});

test('capability changes cannot release an active refresh early', async () => {
  const item = dashboardItem('transient');
  const starts: string[] = [];
  const transitions: string[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.data?.t === 'refresh-started') starts.push(event.data.label);
    if (event.data?.t === 'capability-dropped') transitions.push('dropped');
    if (event.data?.t === 'capability-restored') transitions.push('restored');
  };
  window.addEventListener('message', onMessage);

  try {
    const screen = await renderDashboard([item], {
      [item.url]: transientCapabilityWidget('transient'),
    });
    const iframe = screen.container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('[aria-label="Refresh widget"]'),
      ).toHaveLength(1),
    );
    let refresh = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh widget"]',
    );
    refresh!.click();
    await vi.waitFor(() => {
      expect(starts).toEqual(['transient']);
      expect(refresh!.getAttribute('aria-busy')).toBe('true');
    });

    iframe!.contentWindow?.postMessage(
      { t: 'drop-refresh-capability', label: 'transient' },
      '*',
    );
    await vi.waitFor(() => expect(transitions).toEqual(['dropped']));
    refresh = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh widget"]',
    );
    expect(refresh?.getAttribute('aria-busy')).toBe('true');

    await screen.getByRole('button', { name: 'Refresh all test' }).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(starts).toEqual(['transient']);

    iframe!.contentWindow?.postMessage(
      { t: 'restore-refresh-capability', label: 'transient' },
      '*',
    );
    await vi.waitFor(() =>
      expect(transitions).toEqual(['dropped', 'restored']),
    );
    await screen.getByRole('button', { name: 'Refresh all test' }).click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(starts).toEqual(['transient']);

    iframe!.contentWindow?.postMessage(
      { t: 'finish-refresh', label: 'transient' },
      '*',
    );
    await vi.waitFor(() => {
      refresh = screen.container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh widget"]',
      );
      expect(refresh?.getAttribute('aria-busy')).not.toBe('true');
      expect(iframeText(iframe!)).toBe('new-transient');
    });
  } finally {
    window.removeEventListener('message', onMessage);
  }
});
