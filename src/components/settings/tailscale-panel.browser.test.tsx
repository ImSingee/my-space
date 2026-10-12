import { MantineProvider } from '@mantine/core';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import dayjs from 'dayjs';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { TailscalePanel, TailscaleSettings } from './tailscale-panel';
import { configureTailscale, getTailscaleStatus } from '~server/tailscale';
import type { TailscaleConfigureInput, TailscaleStatus } from '~/tailscale';

type Configure = (config: TailscaleConfigureInput) => Promise<TailscaleStatus>;

vi.mock('~server/tailscale', () => ({
  configureTailscale: vi.fn<() => void>(),
  getTailscaleStatus: vi.fn<() => void>(),
}));

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
const preparingHTTPS: TailscaleStatus = {
  ...starting,
  state: 'preparing-https',
};
const dnsError: TailscaleStatus = {
  ...starting,
  state: 'error',
  message:
    'Enable MagicDNS in your Tailscale DNS settings. Hatch will detect the change and continue connecting automatically.',
  dns: { magicDnsEnabled: false, httpsCertificatesEnabled: true },
};
const settingsEnabled = {
  magicDnsEnabled: true,
  httpsCertificatesEnabled: true,
};
const preparingCertificate: TailscaleStatus = {
  ...preparingHTTPS,
  dns: settingsEnabled,
  https: { phase: 'certificate', retryAt: null },
};
const certificateDelayed: TailscaleStatus = {
  ...preparingCertificate,
  state: 'error',
  message:
    'Your device is connected to Tailscale, but its HTTPS certificate is taking longer than expected. Hatch is still retrying automatically. Check this installation’s internet connection and Tailscale DNS settings.',
  https: { phase: 'certificate-delayed', retryAt: null },
};
const rateLimited: TailscaleStatus = {
  ...certificateDelayed,
  message:
    'The certificate provider has temporarily limited HTTPS certificate requests. Hatch will retry automatically. Reconnecting will not speed this up.',
  https: { phase: 'rate-limited', retryAt: null },
};
const listenerError: TailscaleStatus = {
  ...certificateDelayed,
  message:
    'Your HTTPS certificate is ready, but Hatch could not start its private HTTPS listener. Retrying automatically.',
  https: { phase: 'listener-error', retryAt: null },
};
const httpsReady: TailscaleStatus = {
  ...connected,
  dns: settingsEnabled,
  https: { phase: 'ready', retryAt: null },
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

type Screen = Awaited<ReturnType<typeof render>>;

// Each option's accessible name starts with its label, then its description.
const method = (screen: Screen, name: 'Interactive sign-in' | 'Auth key') =>
  screen.getByRole('radio', { name: new RegExp(`^${name}`) });

function view(status: TailscaleStatus, configure: Configure) {
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

test('auth key enrollment validates input, prevents duplicate requests, and never opens a window', async () => {
  const { open } = popupFixture();
  let resolve!: (value: TailscaleStatus) => void;
  const configure = vi.fn<Configure>(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const screen = await render(view(disconnected, configure));
  await expect.element(method(screen, 'Interactive sign-in')).toBeChecked();
  await method(screen, 'Auth key').click();
  const submit = screen.getByRole('button', { name: 'Connect Tailscale' });
  await expect.element(submit).toBeDisabled();
  await screen
    .getByLabelText('Auth key', { exact: true })
    .fill('tskey-auth-fixture-secret');
  await submit.click();
  await expect
    .element(screen.getByLabelText('Auth key', { exact: true }))
    .toHaveValue('');
  expect(open).not.toHaveBeenCalled();
  expect(configure).toHaveBeenCalledExactlyOnceWith({
    enabled: true,
    hostname: 'hatch',
    authKey: 'tskey-auth-fixture-secret',
  });
  await screen
    .getByLabelText('Auth key', { exact: true })
    .fill('tskey-auth-fixture-secret');
  await submit.click();
  expect(configure).toHaveBeenCalledOnce();
  resolve(starting);
  await screen.rerender(
    view({ ...starting, state: 'needs-approval' }, configure),
  );
  await expect.element(screen.getByText('Approve this device')).toBeVisible();
  await screen.rerender(view(httpsReady, configure));
  await expect
    .element(screen.getByRole('link', { name: 'Open Hatch' }))
    .toHaveAttribute('href', connected.origin);
  expect(open).not.toHaveBeenCalled();
});

test('key failures permit another key or interactive sign-in without retaining the input', async () => {
  const { open } = popupFixture();
  const failure: TailscaleStatus = {
    ...starting,
    state: 'error',
    message: 'Auth key sign-in failed.',
  };
  const configure = vi
    .fn<Configure>()
    .mockResolvedValueOnce(failure)
    .mockResolvedValueOnce(needsLogin);
  const screen = await render(view(disconnected, configure));
  await method(screen, 'Auth key').click();
  await screen
    .getByLabelText('Auth key', { exact: true })
    .fill('tskey-auth-invalid-fixture');
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await screen.rerender(view(failure, configure));
  await expect
    .element(screen.getByLabelText('Auth key', { exact: true }))
    .toHaveValue('');
  await expect
    .element(screen.getByRole('button', { name: 'Reconnect' }))
    .toBeDisabled();
  await screen
    .getByLabelText('Auth key', { exact: true })
    .fill('tskey-auth-new-fixture');
  await expect
    .element(screen.getByRole('button', { name: 'Reconnect' }))
    .toBeEnabled();
  await method(screen, 'Interactive sign-in').click();
  await screen.getByRole('button', { name: 'Reconnect' }).click();
  expect(configure).toHaveBeenLastCalledWith({
    enabled: true,
    hostname: 'hatch',
  });
  expect(open).toHaveBeenCalledOnce();
  await screen.rerender(view(needsLogin, configure));
  await method(screen, 'Auth key').click();
  await expect
    .element(screen.getByLabelText('Auth key', { exact: true }))
    .toHaveValue('');
});

test('settings keep enrollment credentials out of mutation/query caches and never replay failures on reconnect', async () => {
  const { open } = popupFixture();
  const client = new QueryClient();
  vi.mocked(getTailscaleStatus).mockResolvedValue(disconnected);
  let reject!: (reason: Error) => void;
  const configure = vi.mocked(configureTailscale).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <TailscaleSettings />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await method(screen, 'Auth key').click();
  const key = 'tskey-auth-cache-boundary-fixture';
  await screen.getByLabelText('Auth key', { exact: true }).fill(key);
  onlineManager.setOnline(false);
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await expect.poll(() => configure.mock.calls.length).toBe(1);
  const cached = () =>
    JSON.stringify({
      mutations: client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
      queries: client
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    });
  expect(cached()).not.toContain(key);
  reject(new Error('Could not connect. Try again.'));
  await expect
    .element(screen.getByText('Could not connect. Try again.'))
    .toBeVisible();
  onlineManager.setOnline(true);
  await expect
    .element(screen.getByRole('button', { name: 'Connect Tailscale' }))
    .toBeDisabled();
  expect(configure).toHaveBeenCalledOnce();
  expect(cached()).not.toContain(key);
  expect(open).not.toHaveBeenCalled();
  await screen.unmount();
  client.clear();
});

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
  await method(screen, 'Interactive sign-in').click();
  expect(popup.closed).toBe(false);
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

test('certificate preparation closes authorization, offers cancellation, and automatically reveals the ready address', async () => {
  const { popup } = popupFixture();
  const configure = vi.fn<Configure>().mockResolvedValue(preparingHTTPS);
  const screen = await render(view(disconnected, configure));
  await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
  await screen.rerender(view(preparingHTTPS, configure));
  await expect.poll(() => popup.closed).toBe(true);
  await expect.element(screen.getByRole('note')).toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Cancel connection' }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole('button', { name: 'Reconnect' }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('link', { name: 'Open Tailscale DNS settings' }))
    .not.toBeInTheDocument();
  await screen.rerender(
    view(
      {
        ...preparingHTTPS,
        state: 'error',
        message:
          'HTTPS certificate preparation is taking longer than expected. Check Tailscale DNS settings. Retrying automatically.',
      },
      configure,
    ),
  );
  await expect.element(screen.getByRole('note')).not.toBeInTheDocument();
  await expect.element(screen.getByRole('alert')).toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Reconnect' }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole('link', { name: 'Open Tailscale DNS settings' }))
    .toBeVisible();
  await screen.rerender(view(connected, configure));
  await expect.element(screen.getByRole('note')).not.toBeInTheDocument();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('link', { name: 'Open Hatch' }))
    .toHaveAttribute('href', connected.origin);
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

test.each([starting, preparingHTTPS])(
  'canceling a $state connection closes its window and ignores late authorization updates',
  async (status) => {
    const { popup } = popupFixture();
    const configure = vi
      .fn<Configure>()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(disconnected);
    const screen = await render(view(disconnected, configure));
    await screen.getByRole('button', { name: 'Connect Tailscale' }).click();
    await screen.rerender(view(status, configure));
    await screen.getByRole('button', { name: 'Cancel connection' }).click();
    expect(configure).toHaveBeenLastCalledWith({
      enabled: false,
      hostname: 'hatch',
    });
    expect(popup.closed).toBe(true);
    await screen.rerender(view(needsLogin, configure));
    expect(popup.location.replace).not.toHaveBeenCalled();
  },
);

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

const dnsSettingsButton = (screen: Screen) =>
  screen.getByRole('link', { name: 'Open Tailscale DNS settings' });

async function expectDnsSettings(
  screen: Screen,
  magicDns: string,
  httpsCertificates: string,
) {
  await expect
    .element(
      screen.getByRole('row', { name: `MagicDNS ${magicDns}`, exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByRole('row', {
        name: `HTTPS certificates ${httpsCertificates}`,
        exact: true,
      }),
    )
    .toBeVisible();
}

test('DNS diagnostics name the missing setting beside the server guidance and an external settings button', async () => {
  const configure = vi.fn<Configure>();
  const screen = await render(view(dnsError, configure));
  await expect.element(screen.getByText(dnsError.message!)).toBeVisible();
  await expectDnsSettings(screen, 'Not enabled', 'Enabled');
  const button = dnsSettingsButton(screen);
  await expect
    .element(button)
    .toHaveAttribute('href', 'https://login.tailscale.com/admin/dns');
  await expect.element(button).toHaveAttribute('target', '_blank');
  await expect.element(button).toHaveAttribute('rel', 'noreferrer');

  await screen.rerender(
    view(
      {
        ...connected,
        dns: { magicDnsEnabled: true, httpsCertificatesEnabled: true },
      },
      configure,
    ),
  );
  await expect
    .element(screen.getByText(dnsError.message!))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('table', { name: 'Tailscale DNS settings' }))
    .not.toBeInTheDocument();
  await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
});

test('unreadable settings stay unknown, and errors without an HTTPS phase keep both enabled settings as HTTPS not ready', async () => {
  const configure = vi.fn<Configure>();
  const screen = await render(
    view(
      {
        ...dnsError,
        message:
          'Cannot read the MagicDNS setting from Tailscale yet. Retrying automatically.',
        dns: { magicDnsEnabled: null, httpsCertificatesEnabled: true },
      },
      configure,
    ),
  );
  await expectDnsSettings(screen, 'Unknown', 'Enabled');
  await expect.element(screen.getByText('Not enabled')).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('alert', { name: 'HTTPS is not ready' }))
    .not.toBeInTheDocument();
  await expect.element(dnsSettingsButton(screen)).toBeVisible();

  const certificateFailure =
    'HTTPS certificates are enabled, but Hatch could not obtain a certificate. Check network connectivity and your Tailscale HTTPS certificate settings. Retrying automatically.';
  await screen.rerender(
    view(
      { ...dnsError, message: certificateFailure, dns: settingsEnabled },
      configure,
    ),
  );
  await expect
    .element(screen.getByRole('alert', { name: 'HTTPS is not ready' }))
    .toBeVisible();
  await expect.element(screen.getByText(certificateFailure)).toBeVisible();
  await expectDnsSettings(screen, 'Enabled', 'Enabled');
  await expect.element(dnsSettingsButton(screen)).toBeVisible();
});

test('helpers without typed diagnostics keep the settings button only for DNS or certificate settings messages', async () => {
  const configure = vi.fn<Configure>();
  const legacyMessage =
    'HTTPS is not ready. Check Tailscale certificate settings and network connectivity. Retrying automatically.';
  const legacy: TailscaleStatus = {
    ...starting,
    state: 'error',
    message: legacyMessage,
  };
  const screen = await render(view(legacy, configure));
  await expect.element(screen.getByText(legacyMessage)).toBeVisible();
  await expect
    .element(dnsSettingsButton(screen))
    .toHaveAttribute('href', 'https://login.tailscale.com/admin/dns');
  await expect
    .element(screen.getByRole('table', { name: 'Tailscale DNS settings' }))
    .not.toBeInTheDocument();

  for (const message of [rateLimited.message!, listenerError.message!]) {
    await screen.rerender(view({ ...legacy, message }, configure));
    await expect.element(screen.getByText(message)).toBeVisible();
    await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
  }

  const unrelated =
    'Unable to start Tailscale. Check the private state directory.';
  await screen.rerender(view({ ...legacy, message: unrelated }, configure));
  await expect.element(screen.getByText(unrelated)).toBeVisible();
  await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
});

test('typed HTTPS phases move from a calm preparation note through delay, rate-limit, and listener warnings to the ready address', async () => {
  const configure = vi.fn<Configure>();
  const screen = await render(view(preparingCertificate, configure));
  const reconnect = screen.getByRole('button', { name: 'Reconnect' });
  await expect.element(screen.getByRole('note')).toBeVisible();
  await expect
    .element(screen.getByText('Preparing HTTPS', { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('table', { name: 'Tailscale DNS settings' }))
    .not.toBeInTheDocument();
  await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
  await expect.element(reconnect).not.toBeInTheDocument();

  await screen.rerender(view(certificateDelayed, configure));
  await expect.element(screen.getByRole('note')).not.toBeInTheDocument();
  await expect
    .element(
      screen.getByRole('alert', {
        name: 'HTTPS is taking longer than expected',
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText('HTTPS delayed', { exact: true }))
    .toBeVisible();
  await expectDnsSettings(screen, 'Enabled', 'Enabled');
  await expect.element(dnsSettingsButton(screen)).toBeVisible();
  await expect.element(reconnect).toBeEnabled();

  await screen.rerender(view(rateLimited, configure));
  await expect
    .element(
      screen.getByRole('alert', {
        name: 'Certificate requests are temporarily limited',
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText('Waiting to retry', { exact: true }))
    .toBeVisible();
  await expectDnsSettings(screen, 'Enabled', 'Enabled');
  await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
  await expect.element(reconnect).not.toBeInTheDocument();
  await expect
    .element(screen.getByText(/Next automatic attempt/))
    .not.toBeInTheDocument();
  const retryAt = '2030-01-15T15:45:00Z';
  await screen.rerender(
    view(
      { ...rateLimited, https: { phase: 'rate-limited', retryAt } },
      configure,
    ),
  );
  await expect
    .element(
      screen.getByText(dayjs(retryAt).format('MMM D [at] h:mm A'), {
        exact: true,
      }),
    )
    .toHaveAttribute('datetime', retryAt);

  await screen.rerender(view(listenerError, configure));
  await expect
    .element(
      screen.getByRole('alert', { name: 'Secure address could not start' }),
    )
    .toBeVisible();
  await expect.element(dnsSettingsButton(screen)).not.toBeInTheDocument();
  await expect.element(reconnect).toBeEnabled();

  await screen.rerender(view(httpsReady, configure));
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  await expect.element(screen.getByRole('note')).not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Connected', { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Open Hatch' }))
    .toHaveAttribute('href', httpsReady.origin);
});

test('rate limits only offer disconnecting, while listener failures reconnect without leaving an authorization window open', async () => {
  const configure = vi
    .fn<Configure>()
    .mockResolvedValueOnce(disconnected)
    .mockResolvedValueOnce(preparingCertificate);
  const screen = await render(view(rateLimited, configure));
  await expect
    .element(screen.getByRole('button', { name: 'Reconnect' }))
    .not.toBeInTheDocument();
  await screen.getByRole('button', { name: 'Disconnect' }).click();
  expect(configure).toHaveBeenLastCalledWith({
    enabled: false,
    hostname: 'hatch',
  });

  const { popup, open } = popupFixture();
  await screen.rerender(view(listenerError, configure));
  await screen.getByRole('button', { name: 'Reconnect' }).click();
  expect(open).toHaveBeenCalledOnce();
  expect(configure).toHaveBeenLastCalledWith({
    enabled: true,
    hostname: 'hatch',
  });
  await screen.rerender(view(preparingCertificate, configure));
  await expect.poll(() => popup.closed).toBe(true);
  expect(popup.location.replace).not.toHaveBeenCalled();
  await expect.element(screen.getByRole('note')).toBeVisible();
});
