import { MantineProvider } from '@mantine/core';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { TailscalePanel } from './tailscale-panel';
import type { TailscaleConfig, TailscaleStatus } from '~/tailscale';

type Configure = (config: TailscaleConfig) => Promise<TailscaleStatus>;

vi.mock('~server/tailscale', () => ({
  configureTailscale: vi.fn<() => void>(),
  getTailscaleStatus: vi.fn<() => void>(),
}));

afterEach(() => vi.restoreAllMocks());

const disconnected: TailscaleStatus = {
  available: true,
  enabled: false,
  hostname: 'hatch',
  state: 'disconnected',
  loginUrl: null,
  origin: null,
  message: null,
};
const starting: TailscaleStatus = {
  ...disconnected,
  enabled: true,
  state: 'starting',
};
const needsLogin: TailscaleStatus = {
  ...starting,
  state: 'needs-login',
  loginUrl: 'https://login.tailscale.com/a/test-authorization',
};
const connected: TailscaleStatus = {
  ...starting,
  state: 'connected',
  origin: 'https://hatch.example.ts.net',
};

function popupFixture() {
  const popup = {
    opener: window,
    document: document.implementation.createHTMLDocument(),
    closed: false,
    location: { replace: vi.fn<(url: string) => void>() },
    close: vi.fn<() => void>(() => {
      popup.closed = true;
    }),
  };
  const open = vi
    .spyOn(window, 'open')
    .mockReturnValue(popup as unknown as Window);
  return { popup, open };
}

function view(
  status: TailscaleStatus,
  configure: (config: {
    enabled: boolean;
    hostname: string;
  }) => Promise<TailscaleStatus>,
) {
  return (
    <MantineProvider>
      <TailscalePanel
        status={status}
        pending={false}
        error={null}
        onConfigure={configure}
      />
    </MantineProvider>
  );
}

test('Connect reserves one window before the request and navigates it when authorization becomes ready', async () => {
  const { popup, open } = popupFixture();
  let resolve!: (value: TailscaleStatus) => void;
  const configure = vi.fn<Configure>(
    () =>
      new Promise<TailscaleStatus>((done) => {
        resolve = done;
      }),
  );
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(open.mock.invocationCallOrder[0]).toBeLessThan(
    configure.mock.invocationCallOrder[0],
  );
  expect(popup.opener).toBeNull();
  resolve(starting);
  await screen.rerender(view(starting, configure));
  await screen.rerender(view(needsLogin, configure));
  await expect
    .poll(() => popup.location.replace.mock.calls)
    .toEqual([[needsLogin.loginUrl]]);
  await screen.rerender(view({ ...needsLogin }, configure));
  expect(open).toHaveBeenCalledOnce();
  expect(popup.location.replace).toHaveBeenCalledOnce();
  await screen.rerender(view(connected, configure));
  await expect.poll(() => popup.closed).toBe(true);
});

test('blocked windows leave a normal continuation link without reopening on polls', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const configure = vi.fn<Configure>().mockResolvedValue(needsLogin);
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await screen.rerender(view(needsLogin, configure));
  const link = screen.getByRole('link', { name: 'Continue authorization' });
  await expect.element(link).toHaveAttribute('href', needsLogin.loginUrl);
  await expect.element(link).toHaveAttribute('rel', 'noreferrer');
  await screen.rerender(view({ ...needsLogin }, configure));
  expect(open).toHaveBeenCalledOnce();
});

test('an already authorized device closes the waiting window without navigating to login', async () => {
  const { popup } = popupFixture();
  const configure = vi.fn<Configure>().mockResolvedValue(connected);
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await expect.poll(() => popup.closed).toBe(true);
  expect(popup.location.replace).not.toHaveBeenCalled();
});

test('a failed connection request closes its waiting window', async () => {
  const { popup } = popupFixture();
  const configure = vi
    .fn<Configure>()
    .mockRejectedValue(new Error('Connection could not start'));
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await expect.poll(() => popup.closed).toBe(true);
  expect(popup.location.replace).not.toHaveBeenCalled();
});

test('canceling a pending connection closes its window and ignores late authorization updates', async () => {
  const { popup } = popupFixture();
  const configure = vi
    .fn<Configure>()
    .mockResolvedValueOnce(starting)
    .mockResolvedValueOnce(disconnected);
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await screen.rerender(view(starting, configure));
  await screen.getByRole('button', { name: 'Cancel connection' }).click();
  expect(configure).toHaveBeenLastCalledWith({
    enabled: false,
    hostname: 'hatch',
  });
  expect(popup.closed).toBe(true);
  await screen.rerender(view(needsLogin, configure));
  expect(popup.location.replace).not.toHaveBeenCalled();
});

test('opening Settings during pending enrollment never opens an unsolicited window', async () => {
  const { open } = popupFixture();
  const configure = vi.fn<Configure>();
  const screen = await render(view(needsLogin, configure));
  await expect
    .element(screen.getByRole('link', { name: 'Continue authorization' }))
    .toBeVisible();
  await screen.rerender(view({ ...needsLogin }, configure));
  expect(open).not.toHaveBeenCalled();
  expect(configure).not.toHaveBeenCalled();
});
