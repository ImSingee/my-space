import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AppTailscaleStatus } from '~/app-tailscale';
import {
  configureAppTailscale,
  getAppTailscaleStatus,
} from '~server/app-tailscale';
import { getTailscaleStatus } from '~server/tailscale';
import { AppTailscaleServicePanel } from './app-tailscale-service-panel';
vi.mock('~server/app-tailscale', () => ({
  configureAppTailscale: vi.fn<() => void>(),
  getAppTailscaleStatus: vi.fn<() => void>(),
  listAppTailscaleStatuses: vi.fn<() => void>(),
}));
vi.mock('~server/tailscale', () => ({
  getTailscaleStatus: vi.fn<() => void>(),
}));
test('advertising waits for observed readiness, exposes only a ready address, and stop withdraws it', async () => {
  const disabled: AppTailscaleStatus = {
    config: null,
    state: 'disabled',
    origin: null,
    suffix: 'example.ts.net',
    message: null,
  };
  const pending: AppTailscaleStatus = {
    ...disabled,
    config: { appId: 'app-a', serviceName: 'notes', enabled: true },
    state: 'pending',
  };
  const ready: AppTailscaleStatus = {
    ...pending,
    state: 'ready',
    origin: 'https://notes.example.ts.net',
  };
  vi.mocked(getAppTailscaleStatus).mockResolvedValue(disabled);
  vi.mocked(getTailscaleStatus).mockResolvedValue({
    enabled: true,
    hostname: 'hatch',
    available: true,
    state: 'connected',
    origin: 'https://hatch.example.ts.net',
    loginUrl: null,
    message: null,
    tags: ['tag:hatch'],
  });
  vi.mocked(configureAppTailscale)
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce({
      ...pending,
      state: 'disabled',
      config: { ...pending.config!, enabled: false },
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <AppTailscaleServicePanel appId="app-a" slug="notes" />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await screen.getByRole('button', { name: 'Enable address' }).click();
  expect(configureAppTailscale).toHaveBeenLastCalledWith({
    data: { appId: 'app-a', serviceName: 'notes', enabled: true },
  });
  await expect
    .element(screen.getByRole('link', { name: 'Open Tailscale Services' }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Open App' }))
    .not.toBeInTheDocument();
  client.setQueryData(['app-tailscale', 'app-a'], ready);
  await expect
    .element(screen.getByRole('link', { name: 'Open App' }))
    .toHaveAttribute('href', ready.origin + '/');
  await screen.getByRole('button', { name: 'Stop advertising' }).click();
  expect(configureAppTailscale).toHaveBeenLastCalledWith({
    data: { appId: 'app-a', serviceName: 'notes', enabled: false },
  });
  await expect
    .element(screen.getByRole('link', { name: 'Open App' }))
    .not.toBeInTheDocument();
  client.clear();
});
