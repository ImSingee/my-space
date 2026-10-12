import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { ChangePasswordPanel } from './change-password-panel';
import { accountSessionsQueryOptions } from '~queries/account-sessions';

vi.mock('~server/account-sessions', () => ({
  listAccountSessions: vi.fn<() => void>(),
  revokeAccountSession: vi.fn<() => void>(),
}));

const mocks = vi.hoisted(() => ({
  success: vi.fn<(message: string) => void>(),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.success } }));
vi.mock('~auth/client', async () => {
  const { createAuthClient } = await import('better-auth/react');
  return {
    authClient: createAuthClient({
      fetchOptions: {
        customFetchImpl: (input, init) => window.fetch(input, init),
      },
    }),
  };
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

async function panel() {
  const client = new QueryClient();
  const screen = await render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ModalsProvider>
          <ChangePasswordPanel />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  await expect
    .element(screen.getByLabelText('Current password', { exact: true }))
    .not.toBeInTheDocument();
  await screen
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  const dialog = screen.getByRole('dialog');
  await expect.element(dialog).toBeVisible();
  return { screen, client, dialog };
}

async function fill(
  screen: Awaited<ReturnType<typeof panel>>['screen'],
  current = 'current-fixture-password',
) {
  await screen
    .getByLabelText('Current password', { exact: true })
    .fill(current);
  await screen
    .getByLabelText('New password', { exact: true })
    .fill('new-fixture-password');
  await screen
    .getByLabelText('Confirm new password', { exact: true })
    .fill('new-fixture-password');
}

test('password changes require valid confirmation, send one authenticated request, and retain no credentials in mutation cache', async () => {
  let respond!: (value: Response) => void;
  const fetch = vi.spyOn(window, 'fetch').mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const { screen, client, dialog } = await panel();
  client.setQueryData(accountSessionsQueryOptions.queryKey, []);
  const submit = dialog.getByRole('button', { name: 'Change password' });
  await submit.click();
  await expect
    .element(screen.getByText('Enter your current password'))
    .toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  await fill(screen);
  await screen
    .getByLabelText('Confirm new password', { exact: true })
    .fill('mismatched-fixture-password');
  await submit.click();
  await expect
    .element(screen.getByText('Passwords do not match'))
    .toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
  await screen
    .getByLabelText('Confirm new password', { exact: true })
    .fill('new-fixture-password');
  await submit.click();
  // A second form submission before the response must not race the first.
  screen
    .getByLabelText('Current password', { exact: true })
    .element()
    .closest('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await expect.poll(() => fetch.mock.calls.length).toBe(1);
  await expect
    .element(dialog.getByRole('button', { name: 'Cancel' }))
    .toBeDisabled();
  await userEvent.keyboard('{Escape}');
  await expect.element(dialog).toBeVisible();
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toContain('/api/auth/change-password');
  expect(JSON.parse(String(init?.body))).toEqual({
    currentPassword: 'current-fixture-password',
    newPassword: 'new-fixture-password',
    revokeOtherSessions: true,
  });
  respond(Response.json({ token: 'returned-session-secret', user: {} }));
  await expect.element(dialog).not.toBeInTheDocument();
  expect(
    client.getQueryState(accountSessionsQueryOptions.queryKey)?.isInvalidated,
  ).toBe(true);
  await screen
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  await expect
    .element(screen.getByLabelText('Current password', { exact: true }))
    .toHaveValue('');
  await expect
    .element(screen.getByLabelText('New password', { exact: true }))
    .toHaveValue('');
  await expect
    .element(screen.getByLabelText('Confirm new password', { exact: true }))
    .toHaveValue('');
  expect(mocks.success).toHaveBeenCalledOnce();
  const cached = JSON.stringify(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  );
  expect(cached).not.toContain('fixture-password');
  expect(cached).not.toContain('returned-session-secret');
});

test('an offline change fails inline without replay and can be retried after reconnect', async () => {
  const fetch = vi
    .spyOn(window, 'fetch')
    .mockRejectedValue(new TypeError('Offline'));
  const { screen, client, dialog } = await panel();
  await fill(screen);
  onlineManager.setOnline(false);
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect
    .element(screen.getByText('Password could not be changed'))
    .toBeVisible();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(
    client
      .getMutationCache()
      .getAll()
      .some((mutation) => mutation.state.isPaused),
  ).toBe(false);
  await expect
    .element(screen.getByLabelText('New password', { exact: true }))
    .toHaveValue('new-fixture-password');
  onlineManager.setOnline(true);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValue(
    Response.json({ token: 'returned-session-secret', user: {} }),
  );
  await dialog.getByRole('button', { name: 'Change password' }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('canceling a password edit sends no request and reopening starts with empty inputs', async () => {
  const fetch = vi.spyOn(window, 'fetch');
  const { screen, dialog } = await panel();
  await fill(screen);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  await screen
    .getByRole('button', { name: 'Change password', exact: true })
    .click();
  await expect
    .element(screen.getByLabelText('Current password', { exact: true }))
    .toHaveValue('');
  await expect
    .element(screen.getByLabelText('New password', { exact: true }))
    .toHaveValue('');
  await expect
    .element(screen.getByLabelText('Confirm new password', { exact: true }))
    .toHaveValue('');
});
