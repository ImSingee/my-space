import { Button, MantineProvider, Stack, Text } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { dashboardQueryOptions } from '~queries/dashboards';
import type {
  AvailableWidget,
  DashboardData,
  DashboardDraftInput,
  DashboardDraftSaveResult,
} from '~server/dashboards';
import type { DashboardLayoutItem } from '~/lib/dashboard-layout';
import { useDashboardDraft } from './use-dashboard-draft';

const mocks = vi.hoisted(() => ({
  getDashboard: vi.fn<() => Promise<DashboardData>>(),
  saveDashboardDraft:
    vi.fn<
      (input: {
        data: DashboardDraftInput;
      }) => Promise<DashboardDraftSaveResult>
    >(),
}));

vi.mock('~server/dashboards', () => ({
  getDashboard: mocks.getDashboard,
  listAvailableWidgets: () => Promise.resolve([]),
  listDashboards: () => Promise.resolve([]),
  saveDashboardDraft: mocks.saveDashboardDraft,
}));

const initialItem: DashboardLayoutItem = {
  id: 'widget',
  x: 0,
  y: 0,
  w: 4,
  h: 3,
};
const initialData: DashboardData = {
  revision: 7,
  widgets: [
    {
      id: 'widget',
      appId: 'app',
      appSlug: 'app',
      appName: 'App',
      widgetId: 'widget',
      name: 'Widget',
      url: '/widget.js',
      sortOrder: 0,
      defaultSize: { w: 4, h: 3 },
      supportedSizes: [],
    },
  ],
  layouts: {
    desktop: [initialItem],
    tablet: [initialItem],
    mobile: [initialItem],
  },
};
const addedWidget: AvailableWidget = {
  appId: 'second-app',
  appSlug: 'second-app',
  appName: 'Second app',
  widgetId: 'second-widget',
  name: 'Second widget',
  url: '/second-widget.js',
  defaultSize: { w: 4, h: 3 },
  supportedSizes: [],
};
const initialAvailableWidget: AvailableWidget = {
  appId: 'app',
  appSlug: 'app',
  appName: 'App',
  widgetId: 'widget',
  name: 'Widget',
  url: '/widget.js',
  defaultSize: { w: 4, h: 3 },
  supportedSizes: [],
};

function dataWithDesktopX(x: number): DashboardData {
  return {
    ...initialData,
    layouts: {
      ...initialData.layouts,
      desktop: [{ ...initialItem, x }],
    },
  };
}

function dataWithAddedWidget(id: string): DashboardData {
  return {
    ...initialData,
    widgets: [
      ...initialData.widgets,
      {
        id,
        ...addedWidget,
        sortOrder: 1,
      },
    ],
    layouts: {
      desktop: [initialItem, { id, x: 0, y: 3, w: 4, h: 3 }],
      tablet: [initialItem, { id, x: 0, y: 3, w: 4, h: 3 }],
      mobile: [initialItem, { id, x: 0, y: 3, w: 4, h: 3 }],
    },
  };
}

beforeEach(() => {
  mocks.getDashboard.mockReset();
  mocks.saveDashboardDraft.mockReset();
});

function Harness() {
  const editor = useDashboardDraft({
    dashboardId: 'dashboard',
    initialData,
  });
  const [result, setResult] = useState('idle');
  const save = () =>
    void editor.save().then((saved) => setResult(saved ? 'saved' : 'failed'));
  const check = () =>
    void editor
      .checkStatus()
      .then((saved) => setResult(saved ? 'saved' : 'failed'));

  return (
    <Stack>
      <Text data-testid="status">{editor.status.state}</Text>
      <Text data-testid="dirty">{String(editor.dirty)}</Text>
      <Text data-testid="locked">{String(editor.locked)}</Text>
      <Text data-testid="cancel-disabled">{String(editor.cancelDisabled)}</Text>
      <Text data-testid="count">{editor.draft.widgets.length}</Text>
      <Text data-testid="x">{editor.draft.layouts.desktop[0]?.x ?? -1}</Text>
      <Text data-testid="result">{result}</Text>
      <Button
        type="button"
        onClick={() =>
          editor.commitLayout('desktop', [{ ...initialItem, x: 1 }])
        }
      >
        Move
      </Button>
      <Button type="button" onClick={() => editor.addWidget(addedWidget)}>
        Add
      </Button>
      <Button
        type="button"
        onClick={() => editor.addWidget(initialAvailableWidget)}
      >
        Re-add
      </Button>
      <Button type="button" onClick={() => editor.removeWidget('widget')}>
        Remove
      </Button>
      <Button type="button" onClick={save}>
        Save
      </Button>
      <Button type="button" onClick={check}>
        Check status
      </Button>
      <Button type="button" onClick={editor.cancel}>
        Cancel
      </Button>
    </Stack>
  );
}

async function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    dashboardQueryOptions('dashboard').queryKey,
    initialData,
  );
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { screen, queryClient };
}

test('keeps layout and membership edits local until save', async () => {
  const { screen, queryClient } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('1');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('true');
  expect(mocks.saveDashboardDraft).not.toHaveBeenCalled();
  expect(
    queryClient.getQueryData<DashboardData>(
      dashboardQueryOptions('dashboard').queryKey,
    )?.layouts.desktop[0].x,
  ).toBe(0);

  await screen.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.element(screen.getByTestId('count')).toHaveTextContent('2');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('0');
  await expect.element(screen.getByTestId('count')).toHaveTextContent('1');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');

  await screen.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.element(screen.getByTestId('count')).toHaveTextContent('0');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('true');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('count')).toHaveTextContent('1');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
  expect(mocks.saveDashboardDraft).not.toHaveBeenCalled();
});

test('saves the complete draft once and replaces the query cache', async () => {
  const saved = { ...dataWithDesktopX(1), revision: 8 };
  mocks.saveDashboardDraft.mockResolvedValue({ status: 'saved', data: saved });
  const { screen, queryClient } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
  expect(mocks.saveDashboardDraft).toHaveBeenCalledTimes(1);
  const payload = mocks.saveDashboardDraft.mock.calls[0][0].data;
  expect(payload.expectedRevision).toBe(7);
  expect(payload.removedWidgetIds).toEqual([]);
  expect(payload.widgets).toEqual([
    { id: 'widget', appId: 'app', widgetId: 'widget' },
  ]);
  expect(payload.layouts.desktop[0].x).toBe(1);
  expect(payload.layouts.tablet).toHaveLength(1);
  expect(payload.layouts.mobile).toHaveLength(1);
  expect(
    queryClient.getQueryData<DashboardData>(
      dashboardQueryOptions('dashboard').queryKey,
    )?.layouts.desktop[0].x,
  ).toBe(1);
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});

test('submits only placements explicitly removed from the visible baseline', async () => {
  const saved: DashboardData = {
    revision: 8,
    widgets: [],
    layouts: { desktop: [], tablet: [], mobile: [] },
  };
  mocks.saveDashboardDraft.mockResolvedValue({ status: 'saved', data: saved });
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Remove', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();

  const payload = mocks.saveDashboardDraft.mock.calls[0][0].data;
  expect(payload.expectedRevision).toBe(7);
  expect(payload.removedWidgetIds).toEqual(['widget']);
  expect(payload.widgets).toEqual([]);
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});

test('does not remove an existing placement re-added in the same draft', async () => {
  mocks.saveDashboardDraft.mockResolvedValue({
    status: 'saved',
    data: { ...dataWithAddedWidget('saved-second-widget'), revision: 8 },
  });
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Remove', exact: true }).click();
  await screen.getByRole('button', { name: 'Re-add', exact: true }).click();
  await screen.getByRole('button', { name: 'Add', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();

  const payload = mocks.saveDashboardDraft.mock.calls[0][0].data;
  expect(payload.removedWidgetIds).toEqual([]);
  expect(payload.widgets).toHaveLength(2);
  const reAdded = payload.widgets.find((widget) => widget.appId === 'app');
  expect(reAdded).toMatchObject({ appId: 'app', widgetId: 'widget' });
  expect(reAdded?.id).toMatch(/^draft:/);
  expect(payload.layouts.desktop.some((item) => item.id === reAdded?.id)).toBe(
    true,
  );
  expect(payload.layouts.tablet.some((item) => item.id === reAdded?.id)).toBe(
    true,
  );
  expect(payload.layouts.mobile.some((item) => item.id === reAdded?.id)).toBe(
    true,
  );
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
});

test('blocks a stale draft after another tab advances the revision', async () => {
  const latest = { ...dataWithAddedWidget('concurrent-widget'), revision: 8 };
  mocks.saveDashboardDraft.mockResolvedValue({ status: 'conflict' });
  mocks.getDashboard.mockResolvedValue(latest);
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();

  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('conflict');
  await expect.element(screen.getByTestId('locked')).toHaveTextContent('true');
  await expect
    .element(screen.getByTestId('cancel-disabled'))
    .toHaveTextContent('false');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  expect(mocks.saveDashboardDraft).toHaveBeenCalledTimes(1);

  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('editing');
  await expect.element(screen.getByTestId('count')).toHaveTextContent('2');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});

test('recognizes a committed save when only its response was lost', async () => {
  mocks.saveDashboardDraft.mockRejectedValue(new Error('Network error'));
  mocks.getDashboard.mockResolvedValue({
    ...dataWithDesktopX(1),
    revision: 8,
  });
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('editing');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
  expect(mocks.getDashboard).toHaveBeenCalledTimes(1);
});

test('matches server-assigned ids when an added widget response is lost', async () => {
  mocks.saveDashboardDraft.mockRejectedValue(new Error('Network error'));
  mocks.getDashboard.mockResolvedValue(dataWithAddedWidget('saved-widget'));
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Add', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
  await expect.element(screen.getByTestId('count')).toHaveTextContent('2');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});

test('requires a settled recheck before treating a rejected save as failed', async () => {
  mocks.saveDashboardDraft.mockRejectedValue(new Error('Offline'));
  mocks.getDashboard.mockResolvedValue(initialData);
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .element(screen.getByTestId('result'))
    .toHaveTextContent('failed');
  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('unknown');
  await expect.element(screen.getByTestId('locked')).toHaveTextContent('true');
  await expect.element(screen.getByTestId('x')).toHaveTextContent('1');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('1');

  await screen
    .getByRole('button', { name: 'Check status', exact: true })
    .click();
  await expect.element(screen.getByTestId('status')).toHaveTextContent('error');
  await expect.element(screen.getByTestId('locked')).toHaveTextContent('false');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('0');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
  expect(mocks.getDashboard).toHaveBeenCalledTimes(2);
});

test('keeps a pre-commit mismatch locked until a later read sees the commit', async () => {
  mocks.saveDashboardDraft.mockRejectedValue(new Error('Network error'));
  mocks.getDashboard
    .mockResolvedValueOnce(initialData)
    .mockResolvedValueOnce(dataWithDesktopX(1));
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('unknown');
  await expect.element(screen.getByTestId('locked')).toHaveTextContent('true');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('1');

  await screen
    .getByRole('button', { name: 'Check status', exact: true })
    .click();
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});

test('locks an unknown save until the authoritative status is checked', async () => {
  mocks.saveDashboardDraft.mockRejectedValue(new Error('Network error'));
  mocks.getDashboard.mockRejectedValueOnce(new Error('Still offline'));
  const { screen } = await renderHarness();

  await screen.getByRole('button', { name: 'Move', exact: true }).click();
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .element(screen.getByTestId('status'))
    .toHaveTextContent('unknown');
  await expect.element(screen.getByTestId('locked')).toHaveTextContent('true');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.element(screen.getByTestId('x')).toHaveTextContent('1');

  mocks.getDashboard.mockResolvedValueOnce(dataWithDesktopX(1));
  await screen
    .getByRole('button', { name: 'Check status', exact: true })
    .click();
  await expect.element(screen.getByTestId('result')).toHaveTextContent('saved');
  await expect.element(screen.getByTestId('dirty')).toHaveTextContent('false');
});
