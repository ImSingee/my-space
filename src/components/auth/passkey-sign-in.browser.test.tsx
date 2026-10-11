import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { PasskeySignIn } from './passkey-sign-in';

const fixtures = vi.hoisted(() => ({ supported: true, autofill: false }));
type SignInResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};
const mocks = vi.hoisted(() => ({
  onSuccess: vi.fn<() => Promise<void>>(),
  signIn: vi.fn<(options?: { autoFill: boolean }) => Promise<SignInResult>>(),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
}));

vi.mock('~auth/client', () => ({
  authClient: { signIn: { passkey: mocks.signIn } },
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
  fixtures.supported = true;
  fixtures.autofill = false;
  mocks.signIn.mockReset().mockResolvedValue({ data: {}, error: null });
  mocks.onSuccess.mockReset().mockResolvedValue();
});

afterEach(() => vi.unstubAllGlobals());

test('keeps button sign-in available when conditional mediation is unsupported', async () => {
  const screen = await renderPasskeySignIn();
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  expect(mocks.signIn).not.toHaveBeenCalled();

  await screen.getByRole('button', { name: 'Sign in with a passkey' }).click();

  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
  expect(mocks.signIn).toHaveBeenCalledWith();
  expect(mocks.toastSuccess).toHaveBeenCalledWith('Welcome back');
});

test('completes conditional sign-in through the official SDK', async () => {
  fixtures.autofill = true;
  await renderPasskeySignIn();

  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
  expect(mocks.signIn).toHaveBeenCalledExactlyOnceWith({ autoFill: true });
  expect(mocks.toastSuccess).toHaveBeenCalledOnce();
});

test('leaves explicit sign-in usable when optional autofill fails', async () => {
  fixtures.autofill = true;
  mocks.signIn.mockResolvedValueOnce({
    data: null,
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' },
  });
  const screen = await renderPasskeySignIn();
  await vi.waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce());
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  expect(mocks.toastError).not.toHaveBeenCalled();

  await screen.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
  expect(mocks.signIn).toHaveBeenLastCalledWith();
});

test.each([false, true])(
  'retries navigation without repeating authentication and disables pending navigation (autofill: %s)',
  async (autofill) => {
    fixtures.autofill = autofill;
    let release: () => void = () => {};
    const navigation = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.onSuccess.mockRejectedValueOnce(new Error('Route unavailable'));
    mocks.onSuccess.mockImplementationOnce(() => navigation);
    const screen = await renderPasskeySignIn();
    if (!autofill) {
      await screen
        .getByRole('button', { name: 'Sign in with a passkey' })
        .click();
    }

    const retry = screen.getByRole('button', { name: 'Continue', exact: true });
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
    await expect.element(retry).toBeEnabled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    await retry.click();
    await expect.element(retry).toBeDisabled();
    expect(mocks.onSuccess).toHaveBeenCalledTimes(2);
    expect(mocks.signIn).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce());
  },
);

test('keeps SDK-reported cancellation silent and allows a successful retry', async () => {
  mocks.signIn.mockResolvedValueOnce({
    data: null,
    error: { code: 'AUTH_CANCELLED', message: 'Authentication was cancelled' },
  });
  const screen = await renderPasskeySignIn();
  const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();

  await expect.element(button).toBeEnabled();
  expect(mocks.toastError).not.toHaveBeenCalled();
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  await button.click();
  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
});

test('reports a rejected authentication and allows a successful retry', async () => {
  mocks.signIn.mockResolvedValueOnce({
    data: null,
    error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed' },
  });
  const screen = await renderPasskeySignIn();
  const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();

  await vi.waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith('Authentication failed'),
  );
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  await button.click();
  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
});

test('reports a thrown SDK request failure and allows a successful retry', async () => {
  mocks.signIn.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  const screen = await renderPasskeySignIn();
  const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();

  await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce());
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  await button.click();
  await vi.waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledOnce());
});

test('disables pending authentication and ignores completion after leaving login', async () => {
  let release: (result: SignInResult) => void = () => {};
  const authentication = new Promise<SignInResult>((resolve) => {
    release = resolve;
  });
  mocks.signIn.mockImplementationOnce(() => authentication);
  const screen = await renderPasskeySignIn();
  const button = screen.getByRole('button', { name: 'Sign in with a passkey' });
  await button.click();

  await expect.element(button).toBeDisabled();
  expect(mocks.signIn).toHaveBeenCalledOnce();
  await screen.unmount();
  release({ data: {}, error: null });
  await authentication;
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  expect(mocks.toastSuccess).not.toHaveBeenCalled();
});

test('does not offer passkey sign-in or start autofill when WebAuthn is unavailable', async () => {
  fixtures.autofill = true;
  fixtures.supported = false;
  const screen = await renderPasskeySignIn();

  await expect
    .element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
    .not.toBeInTheDocument();
  expect(mocks.signIn).not.toHaveBeenCalled();
});

test.each(['http://127.0.0.1:3700', 'http://[::1]:3700'])(
  'does not offer passkey sign-in or start autofill for IP APP_URL %s',
  async (appOrigin) => {
    fixtures.autofill = true;
    const screen = await renderPasskeySignIn(appOrigin);

    await expect
      .element(screen.getByRole('button', { name: 'Sign in with a passkey' }))
      .not.toBeInTheDocument();
    expect(mocks.signIn).not.toHaveBeenCalled();
  },
);
