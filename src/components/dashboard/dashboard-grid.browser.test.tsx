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
  leftOffset = 0,
  onLayoutCommit = () => {},
}: {
  width: number;
  editing?: boolean;
  previewBreakpoint?: 'desktop' | 'tablet' | 'mobile';
  transformScale?: number;
  leftOffset?: number;
  onLayoutCommit?: OnLayoutCommit;
}) {
  return (
    <div
      data-left-offset={leftOffset}
      style={{
        width,
        marginLeft: leftOffset,
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

async function dragSecondWidgetToFirst({
  container,
  onLayoutCommit,
}: {
  container: HTMLElement;
  onLayoutCommit: ReturnType<typeof vi.fn<OnLayoutCommit>>;
}) {
  const source = container.querySelector<HTMLElement>('[data-widget-id="b"]');
  const target = container.querySelector<HTMLElement>('[data-widget-id="a"]');
  expect(source).toBeTruthy();
  expect(target).toBeTruthy();
  await userEvent.dragAndDrop(source!, target!);
  await vi.waitFor(() => expect(onLayoutCommit).toHaveBeenCalled());
  const [breakpoint, committed] = onLayoutCommit.mock.calls.at(-1)!;

  expect(breakpoint).toBe('desktop');
  return committed;
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

test.each([1, 0.8])(
  'commits drag coordinates relative to an offset grid at scale %s',
  async (transformScale) => {
    const atOriginCommit = vi.fn<OnLayoutCommit>();
    const offsetCommit = vi.fn<OnLayoutCommit>();
    const { container } = await render(
      <>
        <Harness
          width={1200}
          editing
          previewBreakpoint="desktop"
          transformScale={transformScale}
          onLayoutCommit={atOriginCommit}
        />
        <Harness
          width={1200}
          editing
          previewBreakpoint="desktop"
          transformScale={transformScale}
          leftOffset={240}
          onLayoutCommit={offsetCommit}
        />
      </>,
    );
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.react-grid-item')).toHaveLength(4);
    });

    const atOriginContainer = container.querySelector<HTMLElement>(
      '[data-left-offset="0"]',
    );
    const offsetContainer = container.querySelector<HTMLElement>(
      '[data-left-offset="240"]',
    );
    expect(atOriginContainer).toBeTruthy();
    expect(offsetContainer).toBeTruthy();

    vi.stubGlobal('process', { env: {} });
    try {
      const atOrigin = await dragSecondWidgetToFirst({
        container: atOriginContainer!,
        onLayoutCommit: atOriginCommit,
      });
      const offset = await dragSecondWidgetToFirst({
        container: offsetContainer!,
        onLayoutCommit: offsetCommit,
      });

      expect(atOrigin.find((item) => item.id === 'b')?.x).not.toBe(6);
      expect(offset).toEqual(atOrigin);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

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
  await userEvent.hover(target!);
  expect(getComputedStyle(handle!).opacity).toBe('1');
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
