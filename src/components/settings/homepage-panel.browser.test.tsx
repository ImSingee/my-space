import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { HomepageSettings } from '~server/homepage';
import type { HomepageTarget } from '~/homepage';
import { HomepagePanel } from './homepage-panel';

const fixture = vi.hoisted(() => ({
  userId: 'a',
  saved: new Map<string, HomepageSettings>(),
  loadFailure: false,
  saveFailure: false,
  update:
    vi.fn<(input: { data: HomepageTarget }) => Promise<HomepageSettings>>(),
  success: vi.fn<() => void>(),
}));
vi.mock('~auth/client', () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: fixture.userId } },
      isPending: false,
    }),
  },
}));
vi.mock('sonner', () => ({ toast: { success: fixture.success } }));
vi.mock('~server/homepage', () => ({
  getHomepageSettings: async () => {
    if (fixture.loadFailure) throw new Error('Homepage request failed');
    return fixture.saved.get(fixture.userId)!;
  },
  updateHomepageSettings: fixture.update,
}));
vi.mock('~queries/dashboards', () => ({
  dashboardsQueryOptions: {
    queryKey: ['dashboards'],
    queryFn: async () => [{ id: 'd1', name: 'Work Dashboard' }],
  },
}));
vi.mock('~queries/apps', () => ({
  normalizedManifestQueryOptions: (id: string) => ({
    queryKey: ['manifest', id],
    queryFn: async () => ({
      app: { routes: [{ path: '/reports', description: 'Reports' }] },
    }),
  }),
}));

beforeEach(() => {
  fixture.userId = 'a';
  fixture.loadFailure = false;
  fixture.saveFailure = false;
  vi.clearAllMocks();
  for (const userId of ['a', 'b'])
    fixture.saved.set(userId, {
      userId,
      homepage: { kind: 'page', page: 'dashboard' },
      available: true,
      apps: [{ id: 'app1', name: 'Reports App' }],
    });
  fixture.update.mockImplementation(async ({ data }) => {
    if (fixture.saveFailure) throw new Error('Save request failed');
    const settings = {
      ...fixture.saved.get(fixture.userId)!,
      homepage: data,
      available: true,
    };
    fixture.saved.set(fixture.userId, settings);
    return settings;
  });
});
afterEach(() => fixture.saved.clear());

function view(client: QueryClient) {
  return (
    <MantineProvider>
      <QueryClientProvider client={client}>
        <HomepagePanel />
      </QueryClientProvider>
    </MantineProvider>
  );
}
async function panel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(view(client));
  return { screen, client };
}

test('App entry edits survive a failed save and retry persists the preference without navigating', async () => {
  const { screen } = await panel();
  await screen.getByRole('combobox', { name: 'Open Hatch to' }).click();
  await screen
    .getByRole('option', { name: 'Reports App', exact: true })
    .click();
  await screen
    .getByRole('combobox', { name: 'App entry point' })
    .fill('/reports?period=month');
  fixture.saveFailure = true;
  await screen.getByRole('button', { name: 'Save homepage' }).click();
  await expect.element(screen.getByText('Save request failed')).toBeVisible();
  await expect
    .element(screen.getByRole('combobox', { name: 'App entry point' }))
    .toHaveValue('/reports?period=month');
  expect(fixture.saved.get('a')?.homepage).toEqual({
    kind: 'page',
    page: 'dashboard',
  });
  fixture.saveFailure = false;
  await screen.getByRole('button', { name: 'Save homepage' }).click();
  await expect
    .element(screen.getByRole('button', { name: 'Save homepage' }))
    .toBeDisabled();
  expect(fixture.saved.get('a')?.homepage).toEqual({
    kind: 'app',
    appId: 'app1',
    entryHash: '/reports?period=month',
  });
  expect(fixture.success).toHaveBeenCalledOnce();
});

test('preferences remain separated when switching accounts in one QueryClient', async () => {
  fixture.saved.set('a', {
    ...fixture.saved.get('a')!,
    homepage: { kind: 'page', page: 'agent' },
  });
  const { screen, client } = await panel();
  await expect
    .element(screen.getByRole('combobox', { name: 'Open Hatch to' }))
    .toHaveValue('Agent');
  fixture.userId = 'b';
  await screen.rerender(view(client));
  await expect
    .element(screen.getByRole('combobox', { name: 'Open Hatch to' }))
    .toHaveValue('Default Dashboard');
  await screen.getByRole('combobox', { name: 'Open Hatch to' }).click();
  await screen
    .getByRole('option', { name: 'Work Dashboard', exact: true })
    .click();
  await screen.getByRole('button', { name: 'Save homepage' }).click();
  await expect
    .element(screen.getByRole('button', { name: 'Save homepage' }))
    .toBeDisabled();
  fixture.userId = 'a';
  await screen.rerender(view(client));
  await expect
    .element(screen.getByRole('combobox', { name: 'Open Hatch to' }))
    .toHaveValue('Agent');
  expect(fixture.saved.get('b')?.homepage).toEqual({
    kind: 'dashboard',
    dashboardId: 'd1',
  });
});

test('failed loading can be retried and an unavailable saved target can be replaced', async () => {
  fixture.loadFailure = true;
  fixture.saved.set('a', {
    ...fixture.saved.get('a')!,
    homepage: { kind: 'app', appId: 'deleted', entryHash: '/reports' },
    available: false,
  });
  const { screen } = await panel();
  await expect
    .element(screen.getByText('Homepage request failed'))
    .toBeVisible();
  fixture.loadFailure = false;
  await screen.getByRole('button', { name: 'Try again' }).click();
  await expect
    .element(screen.getByText('Your saved homepage is unavailable'))
    .toBeVisible();
  await screen.getByRole('combobox', { name: 'Open Hatch to' }).click();
  await screen.getByRole('option', { name: 'Agent', exact: true }).click();
  await screen.getByRole('button', { name: 'Save homepage' }).click();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  expect(fixture.saved.get('a')?.homepage).toEqual({
    kind: 'page',
    page: 'agent',
  });
});
