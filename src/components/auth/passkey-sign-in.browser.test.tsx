import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { PasskeySignIn } from './passkey-sign-in';

const fixtures = vi.hoisted(() => ({
  autofill: false,
  supported: true,
}));

const mocks = vi.hoisted(() => ({
  onSuccess: vi.fn<() => Promise<void>>(async () => {}),
  signIn: vi.fn<
    (options: { autoFill: boolean }) => Promise<{
      data: unknown;
      error: { code?: string; message?: string } | null;
    }>
  >(async () => ({ data: {}, error: null })),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  fetch: vi.fn<() => Promise<{ data: object; error: null }>>(async () => ({
    data: {},
    error: null,
  })),
  notify: vi.fn<() => void>(),
}));

vi.mock('~auth/client', () => ({
  authClient: { $fetch: mocks.fetch, $store: { notify: mocks.notify } },
}));

vi.mock('~auth/passkey-credential', () => ({
  authenticatePasskey: async (_options: unknown, conditional: boolean) => {
    const result = await mocks.signIn({ autoFill: conditional });
    if (result.error) throw result.error;
    return { clientExtensionResults: {} };
  },
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

async function renderPasskeySignIn(appOrigin = window.location.origin) {
  vi.stubGlobal(
    'PublicKeyCredential',
    fixtures.supported
      ? { isConditionalMediationAvailable: async () => fixtures.autofill }
      : undefined,
  );
  return render(
    <MantineProvider>
      <PasskeySignIn appOrigin={appOrigin} onSuccess={mocks.onSuccess} />
    </MantineProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.autofill = false;
  fixtures.supported = true;
  mocks.signIn.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => vi.unstubAllGlobals());

test('signs in from the explicit passkey action', async () => {
  const screen = await renderPasskeySignIn();

  await screen.getByRole('button', { name: 'Sign in with a passkey' }).click();

  await vi.waitFor(() => {
    expect(mocks.signIn).toHaveBeenCalledWith({ autoFill: false });
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
  });
  expect(mocks.toastSuccess).toHaveBeenCalledWith('Welcome back');
});

test('completes conditional UI sign-in without touching the password form', async () => {
  fixtures.autofill = true;

  await renderPasskeySignIn();

  await vi.waitFor(() => {
    expect(mocks.signIn).toHaveBeenCalledWith({ autoFill: true });
    expect(mocks.onSuccess).toHaveBeenCalledOnce();
  });
});

test('keeps a dismissed native prompt silent and the explicit action usable', async () => {
  mocks.signIn.mockResolvedValue({
    data: null,
    error: {
      code: 'ERROR_CEREMONY_ABORTED',
      message: 'Passkey registration was cancelled',
    },
  });
  const screen = await renderPasskeySignIn();
  const button = screen.getByRole('button', {
    name: 'Sign in with a passkey',
  });

  await button.click();

  await vi.waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce());
  expect(mocks.toastError).not.toHaveBeenCalled();
  await expect.element(button).toBeEnabled();
});

test.each(['AbortError', 'NotAllowedError'])(
  'keeps native %s silent and allows another explicit sign-in',
  async (name) => {
    mocks.signIn.mockRejectedValueOnce(new DOMException('Cancelled', name));
    const screen = await renderPasskeySignIn();
    const button = screen.getByRole('button', {
      name: 'Sign in with a passkey',
    });
    await button.click();
    await vi.waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce());
    await expect.element(button).toBeEnabled();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    await button.click();
    await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
  },
);

test('does not offer passkey sign-in when WebAuthn is unavailable', async () => {
  fixtures.supported = false;
  const screen = await renderPasskeySignIn();

  await expect
    .element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
    .not.toBeInTheDocument();
  expect(mocks.signIn).not.toHaveBeenCalled();
});

test.each(['http://127.0.0.1:3700', 'http://[::1]:3700'])(
  'hides both explicit and conditional sign-in for IP APP_URL %s',
  async (appOrigin) => {
    fixtures.autofill = true;
    const screen = await renderPasskeySignIn(appOrigin);

    await expect
      .element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
      .not.toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
  },
);
