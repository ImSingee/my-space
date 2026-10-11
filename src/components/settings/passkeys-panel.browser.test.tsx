import { MantineProvider } from '@mantine/core';
import type { Passkey } from '@better-auth/passkey';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { PasskeysPanel } from './passkeys-panel';

const fixtures = vi.hoisted(() => ({
  passkeys: [] as Passkey[],
  supported: true,
}));

const mocks = vi.hoisted(() => ({
  addPasskey: vi.fn<
    () => Promise<{ data: Record<string, never>; error: null }>
  >(async () => ({ data: {}, error: null })),
  deletePasskey: vi.fn<
    (input: { id: string }) => Promise<{
      data: { status: boolean };
      error: null;
    }>
  >(async () => ({ data: { status: true }, error: null })),
  openConfirmModal: vi.fn<(options: unknown) => void>(),
  toastError: vi.fn<(message: string) => void>(),
  toastSuccess: vi.fn<(message: string) => void>(),
  updatePasskey: vi.fn<
    (input: { id: string; name: string }) => Promise<{
      data: Record<string, never>;
      error: null;
    }>
  >(async () => ({ data: {}, error: null })),
}));

vi.mock('~auth/client', () => ({
  authClient: {
    useListPasskeys: () => ({
      data: fixtures.passkeys,
      error: null,
      isPending: false,
    }),
    passkey: {
      addPasskey: mocks.addPasskey,
      deletePasskey: mocks.deletePasskey,
      updatePasskey: mocks.updatePasskey,
    },
  },
}));

vi.mock('@mantine/modals', () => ({
  modals: { openConfirmModal: mocks.openConfirmModal },
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

async function renderPanel(appOrigin = window.location.origin) {
  vi.stubGlobal('PublicKeyCredential', fixtures.supported ? {} : undefined);
  return render(
    <MantineProvider>
      <PasskeysPanel appOrigin={appOrigin} />
    </MantineProvider>,
  );
}

function passkeyFixture(overrides: Partial<Passkey> = {}): Passkey {
  return {
    id: 'passkey-1',
    name: 'Laptop',
    publicKey: 'public-key',
    userId: 'user-1',
    credentialID: 'credential-1',
    counter: 0,
    deviceType: 'singleDevice',
    backedUp: false,
    transports: 'internal',
    createdAt: new Date('2026-09-03T00:00:00.000Z'),
    aaguid: '00000000-0000-0000-0000-000000000000',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.passkeys = [];
  fixtures.supported = true;
});

afterEach(() => vi.unstubAllGlobals());

test('adds a passkey from the empty security state', async () => {
  const screen = await renderPanel();

  await expect.element(screen.getByText('No passkeys yet')).toBeVisible();
  await screen.getByRole('button', { name: 'Add passkey' }).click();

  await vi.waitFor(() => expect(mocks.addPasskey).toHaveBeenCalledOnce());
  expect(mocks.toastSuccess).toHaveBeenCalledWith('Passkey added');
});

test('allows enrollment from a domain different from the canonical APP_URL', async () => {
  const screen = await renderPanel('https://hatch.example.test');
  await screen.getByRole('button', { name: 'Add passkey' }).click();
  await vi.waitFor(() => expect(mocks.addPasskey).toHaveBeenCalledOnce());
});

test('keeps rename and delete working on an IP origin with creation disabled', async () => {
  fixtures.passkeys = [passkeyFixture()];
  const screen = await renderPanel('http://[::1]:3700');

  await expect
    .element(screen.getByRole('button', { name: 'Add passkey' }))
    .toBeDisabled();
  await expect
    .element(screen.getByText(/IP addresses are not supported/))
    .toBeVisible();
  expect(mocks.addPasskey).not.toHaveBeenCalled();

  await screen.getByRole('button', { name: 'Rename Laptop' }).click();
  const nameInput = screen.getByRole('textbox', { name: 'Name for Laptop' });
  await nameInput.fill('Office security key');
  await screen.getByRole('button', { name: 'Save name for Laptop' }).click();

  await vi.waitFor(() =>
    expect(mocks.updatePasskey).toHaveBeenCalledWith({
      id: 'passkey-1',
      name: 'Office security key',
    }),
  );

  await screen.getByRole('button', { name: 'Delete Laptop' }).click();
  const confirmation = mocks.openConfirmModal.mock.calls.at(-1)?.[0] as
    | { children?: ReactNode; onConfirm?: () => void }
    | undefined;
  expect(confirmation?.children).toBeDefined();
  confirmation?.onConfirm?.();

  await vi.waitFor(() =>
    expect(mocks.deletePasskey).toHaveBeenCalledWith({ id: 'passkey-1' }),
  );
});

test('explains browser support while keeping existing passkeys manageable', async () => {
  fixtures.supported = false;
  fixtures.passkeys = [
    passkeyFixture({
      name: undefined,
      aaguid: 'bada5566-a7aa-401f-bd96-45619a55120d',
    }),
  ];
  const screen = await renderPanel();

  await expect
    .element(screen.getByText('Passkeys are not available in this browser'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: 'Add passkey' }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole('button', { name: 'Rename 1Password' }))
    .toBeEnabled();
  await expect
    .element(screen.getByRole('button', { name: 'Delete 1Password' }))
    .toBeEnabled();
});
