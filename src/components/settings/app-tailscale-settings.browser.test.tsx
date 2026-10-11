import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppTailscaleStatus } from '~/app-tailscale';
import {
  configureAppTailscale,
  getAppTailscaleStatus,
  listAppTailscaleStatuses,
} from '~server/app-tailscale';
import { getTailscaleStatus } from '~server/tailscale';
import { AppTailscaleSettings } from './app-tailscale-settings';

vi.mock('~queries/apps', () => ({
  appsQueryOptions: {
    queryKey: ['apps'],
    queryFn: async () => [
      { id: 'app-a', name: 'Notes', slug: 'notes', status: 'active' },
      { id: 'app-b', name: 'Tasks', slug: 'tasks', status: 'active' },
    ],
  },
}));
vi.mock('~server/app-tailscale', () => ({
  configureAppTailscale: vi.fn<() => void>(),
  getAppTailscaleStatus: vi.fn<() => void>(),
  listAppTailscaleStatuses: vi.fn<() => void>(),
}));
vi.mock('~server/tailscale', () => ({
  getTailscaleStatus: vi.fn<() => void>(),
}));

test('switching Apps discards drafts and configures only the selected stable identity', async () => {
  const disabled: AppTailscaleStatus = {
    config: null,
    state: 'disabled',
    origin: null,
    suffix: 'example.ts.net',
    message: null,
  };
  vi.mocked(getAppTailscaleStatus).mockResolvedValue(disabled);
  vi.mocked(listAppTailscaleStatuses).mockResolvedValue([]);
  vi.mocked(getTailscaleStatus).mockResolvedValue({
    enabled: true,
    hostname: 'hatch',
    available: true,
    state: 'connected',
    origin: 'https://hatch.example.ts.net',
    loginUrl: null,
    message: null,
  });
  vi.mocked(configureAppTailscale).mockResolvedValue({
    ...disabled,
    config: { appId: 'app-b', serviceName: 'tasks', enabled: true },
    state: 'pending',
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <AppTailscaleSettings />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await screen
    .getByRole('button', { name: 'Configure Notes', exact: true })
    .click();
  await screen
    .getByRole('textbox', { name: 'Tailscale service name' })
    .fill('draft');
  await screen
    .getByRole('button', { name: 'Close configuration', exact: true })
    .click();
  await screen
    .getByRole('button', { name: 'Configure Tasks', exact: true })
    .click();
  await expect
    .element(screen.getByRole('textbox', { name: 'Tailscale service name' }))
    .toHaveValue('tasks');
  await screen.getByRole('button', { name: 'Enable address' }).click();
  expect(configureAppTailscale).toHaveBeenLastCalledWith({
    data: { appId: 'app-b', serviceName: 'tasks', enabled: true },
  });
  await screen
    .getByRole('button', { name: 'Close configuration', exact: true })
    .click();
  await screen
    .getByRole('button', { name: 'Configure Notes', exact: true })
    .click();
  await expect
    .element(screen.getByRole('textbox', { name: 'Tailscale service name' }))
    .toHaveValue('notes');
  await expect
    .element(screen.getByRole('button', { name: 'Enable address' }))
    .toBeVisible();
  expect(configureAppTailscale).toHaveBeenCalledTimes(1);
  await screen
    .getByRole('button', { name: 'Close configuration', exact: true })
    .click();
  client.setQueryData(
    ['app-tailscale-statuses'],
    [
      {
        appId: 'app-a',
        status: {
          ...disabled,
          config: { appId: 'app-a', serviceName: 'notes', enabled: true },
          state: 'ready',
          origin: 'https://notes.example.ts.net',
        },
      },
      {
        appId: 'app-b',
        status: {
          ...disabled,
          config: { appId: 'app-b', serviceName: 'tasks', enabled: true },
          state: 'pending',
        },
      },
    ],
  );
  await expect
    .element(screen.getByRole('row', { name: /Notes/ }).getByRole('link'))
    .toHaveAttribute('href', 'https://notes.example.ts.net/');
  await expect
    .element(screen.getByRole('row', { name: /Tasks/ }).getByRole('link'))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('row', { name: /Tasks/ }))
    .toHaveTextContent('https://tasks.example.ts.net/');
  client.clear();
});
