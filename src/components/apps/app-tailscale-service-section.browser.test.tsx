import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppTailscaleStatus } from '~/app-tailscale';
import { getAppTailscaleStatus } from '~server/app-tailscale';
import { AppTailscaleServiceSection } from './app-tailscale-service-section';

vi.mock('~server/app-tailscale', () => ({
  getAppTailscaleStatus: vi.fn<() => void>(),
  listAppTailscaleStatuses: vi.fn<() => void>(),
}));

test('only enabled Apps show a read-only Service section and only ready Apps expose access links', async () => {
  let status: AppTailscaleStatus = {
    config: null,
    state: 'disabled',
    origin: null,
    suffix: 'example.ts.net',
    message: null,
  };
  vi.mocked(getAppTailscaleStatus).mockImplementation(async () => status);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRootRoute({
    component: () => <AppTailscaleServiceSection appId="app-a" />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await expect
    .poll(() => vi.mocked(getAppTailscaleStatus).mock.calls.length)
    .toBeGreaterThan(0);
  await expect
    .element(screen.getByRole('region', { name: 'Tailscale Service' }))
    .not.toBeInTheDocument();
  status = {
    ...status,
    config: { appId: 'app-a', serviceName: 'notes', enabled: true },
    state: 'pending',
  };
  client.setQueryData(['app-tailscale', 'app-a'], status);
  await expect
    .element(screen.getByRole('region', { name: 'Tailscale Service' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Open via Tailscale' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('textbox', { name: 'Tailscale service name' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Stop advertising' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('link', { name: 'Manage in Tailscale settings' }))
    .toHaveAttribute('href', '/settings/tailscale');
  status = {
    ...status,
    state: 'ready',
    origin: 'https://notes.example.ts.net',
  };
  client.setQueryData(['app-tailscale', 'app-a'], status);
  await expect
    .element(screen.getByRole('link', { name: 'Open via Tailscale' }))
    .toHaveAttribute('href', status.origin + '/');
  status = {
    ...status,
    state: 'disabled',
    origin: null,
    config: { ...status.config!, enabled: false },
  };
  client.setQueryData(['app-tailscale', 'app-a'], status);
  await expect
    .element(screen.getByRole('region', { name: 'Tailscale Service' }))
    .not.toBeInTheDocument();
  client.clear();
});
