import { MantineProvider } from '@mantine/core';
import type { ComponentProps } from 'react';
import { userEvent } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type {
  DashboardLayoutItem,
  DashboardLayouts,
} from '~/lib/dashboard-layout';
import type { DashboardItem } from '~server/dashboards';
import { DashboardGrid } from './dashboard-grid';

type OnLayoutCommit = ComponentProps<typeof DashboardGrid>['onLayoutCommit'];

vi.mock('./widget-card', () => ({
  WidgetCard: ({
    item,
    geometry,
    editing,
  }: {
    item: DashboardItem;
    geometry: DashboardLayoutItem;
    editing: boolean;
  }) => (
    <div
      className="widget-drag-handle"
      data-editing={editing}
      data-widget-id={item.id}
    >
      {item.name}:{geometry.w}x{geometry.h}
    </div>
  ),
}));

const widgets: DashboardItem[] = ['a', 'b'].map((id, sortOrder) => ({
  id,
  appId: `app-${id}`,
  appSlug: `app-${id}`,
  appName: `App ${id}`,
  widgetId: `widget-${id}`,
  name: `Widget ${id}`,
  url: `/widgets/${id}.js`,
  sortOrder,
  defaultSize: { w: 4, h: 3 },
  supportedSizes:
    id === 'b'
      ? [
          { w: 4, h: 2 },
          { w: 6, h: 3 },
        ]
      : [],
}));

const layouts: DashboardLayouts = {
  desktop: [
    { id: 'a', x: 0, y: 0, w: 6, h: 2 },
    { id: 'b', x: 6, y: 0, w: 6, h: 2 },
  ],
  tablet: [
    { id: 'a', x: 0, y: 0, w: 4, h: 2 },
    { id: 'b', x: 4, y: 0, w: 4, h: 2 },
  ],
  mobile: [
    { id: 'a', x: 0, y: 0, w: 4, h: 2 },
    { id: 'b', x: 0, y: 2, w: 4, h: 2 },
  ],
};

function Harness({
  width,
  editing = false,
  previewBreakpoint,
  transformScale = 1,
  onLayoutCommit = () => {},
}: {
  width: number;
  editing?: boolean;
  previewBreakpoint?: 'desktop' | 'tablet' | 'mobile';
  transformScale?: number;
  onLayoutCommit?: OnLayoutCommit;
}) {
  return (
    <div
      style={{
        width,
        transform:
          transformScale === 1 ? undefined : `scale(${transformScale})`,
        transformOrigin: 'top left',
      }}
    >
      <MantineProvider>
        <DashboardGrid
          items={widgets}
          layouts={layouts}
          editing={editing}
          previewBreakpoint={previewBreakpoint}
          transformScale={transformScale}
          onRemove={() => {}}
          onLayoutCommit={onLayoutCommit}
        />
      </MantineProvider>
    </div>
  );
}

function readItems(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('.react-grid-item')].map(
    (element) => {
      const match = /translate\(([\d.-]+)px,\s*([\d.-]+)px\)/.exec(
        element.style.transform,
      );
      return {
        x: match ? Number.parseFloat(match[1]) : Number.NaN,
        y: match ? Number.parseFloat(match[2]) : Number.NaN,
        width: Number.parseFloat(element.style.width),
      };
    },
  );
}

test('view mode selects the desktop layout from measured width', async () => {
  const { container } = await render(<Harness width={1100} />);
  await vi.waitFor(() => {
    expect(container.querySelector('[data-breakpoint="desktop"]')).toBeTruthy();
    const items = readItems(container);
    expect(items).toHaveLength(2);
    expect(items[0].y).toBe(items[1].y);
    expect(items[0].x).not.toBe(items[1].x);
    const multiSizeWidget = container
      .querySelector('[data-widget-id="b"]')
      ?.closest('.react-grid-item');
    const resizeHandle = multiSizeWidget?.querySelector(
      '.react-resizable-handle',
    );
    expect(resizeHandle).toBeTruthy();
    expect(window.getComputedStyle(resizeHandle!).display).toBe('none');
  });
});

test('edit mode exposes the multi-footprint resize handle', async () => {
  const { container } = await render(<Harness width={1100} editing />);
  await vi.waitFor(() => {
    const multiSizeWidget = container
      .querySelector('[data-widget-id="b"]')
      ?.closest('.react-grid-item');
    const resizeHandle = multiSizeWidget?.querySelector(
      '.react-resizable-handle',
    );
    expect(resizeHandle).toBeTruthy();
    expect(window.getComputedStyle(resizeHandle!).display).not.toBe('none');
  });
});

test('view mode selects and renders the mobile layout', async () => {
  const { container } = await render(<Harness width={460} />);
  await vi.waitFor(() => {
    expect(container.querySelector('[data-breakpoint="mobile"]')).toBeTruthy();
    const items = readItems(container);
    expect(items).toHaveLength(2);
    expect(items[0].x).toBe(items[1].x);
    expect(items[0].y).not.toBe(items[1].y);
    expect(items[0].width).toBeGreaterThan(400);
  });
});

test('edit preview uses the selected layout independent of host width', async () => {
  const { container } = await render(
    <Harness width={1000} editing previewBreakpoint="mobile" />,
  );
  await vi.waitFor(() => {
    expect(container.querySelector('[data-breakpoint="mobile"]')).toBeTruthy();
    const items = readItems(container);
    expect(items[0].x).toBe(items[1].x);
    expect(items[0].y).not.toBe(items[1].y);
    expect(container.querySelector('[data-editing="true"]')).toBeTruthy();
  });
});

test('commits logical grid coordinates when the preview is scaled', async () => {
  const onLayoutCommit = vi.fn<OnLayoutCommit>();
  const { container } = await render(
    <Harness
      width={1200}
      editing
      previewBreakpoint="desktop"
      transformScale={0.8}
      onLayoutCommit={onLayoutCommit}
    />,
  );
  await vi.waitFor(() => {
    expect(container.querySelectorAll('.react-grid-item')).toHaveLength(2);
  });

  const source = container.querySelector<HTMLElement>('[data-widget-id="a"]');
  const target = container.querySelector<HTMLElement>('[data-widget-id="b"]');
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  vi.stubGlobal('process', { env: {} });
  try {
    await userEvent.dragAndDrop(source!, target!);
    await vi.waitFor(() => expect(onLayoutCommit).toHaveBeenCalled());
    const [breakpoint, committed] = onLayoutCommit.mock.calls.at(-1)!;
    expect(breakpoint).toBe('desktop');
    expect(committed.find((item) => item.id === 'a')?.x).not.toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('commits a resize when the preview is scaled', async () => {
  const onLayoutCommit = vi.fn<OnLayoutCommit>();
  const { container } = await render(
    <Harness
      width={1200}
      editing
      previewBreakpoint="desktop"
      transformScale={0.8}
      onLayoutCommit={onLayoutCommit}
    />,
  );
  await vi.waitFor(() => {
    expect(container.querySelector('.react-resizable-handle')).toBeTruthy();
  });

  const handle = container.querySelector<HTMLElement>(
    '.react-grid-item:first-child .react-resizable-handle',
  );
  const target = container.querySelector<HTMLElement>('[data-widget-id="b"]');
  expect(handle).toBeTruthy();
  expect(target).toBeTruthy();
  vi.stubGlobal('process', { env: {} });
  try {
    await userEvent.dragAndDrop(handle!, target!);
    await vi.waitFor(() => expect(onLayoutCommit).toHaveBeenCalled());
    const [breakpoint, committed] = onLayoutCommit.mock.calls.at(-1)!;
    expect(breakpoint).toBe('desktop');
    expect(committed.find((item) => item.id === 'a')?.w).not.toBe(6);
  } finally {
    vi.unstubAllGlobals();
  }
});
