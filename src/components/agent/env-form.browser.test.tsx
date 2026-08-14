import { MantineProvider } from '@mantine/core';
import { userEvent } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { EnvForm, type EnvEntry } from './env-form';

const variables = [
  {
    key: 'GITHUB_TOKEN',
    description: 'A token that can read the repository.',
    secret: true,
  },
  {
    key: 'PROJECT_ID',
    description: 'The public project identifier.',
    secret: false,
  },
];

test('masks values and lets the user override each privacy default', async () => {
  const onSubmit = vi.fn<(entries: EnvEntry[]) => Promise<boolean>>(
    async () => true,
  );
  const screen = await render(
    <MantineProvider>
      <EnvForm
        reason="Connect the app to your account."
        variables={variables}
        onSubmit={onSubmit}
      />
    </MantineProvider>,
  );
  const token = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  const projectId = screen.getByLabelText(/^PROJECT_ID(?: \*)?$/);
  const tokenPrivacy = screen.getByRole('switch', {
    name: 'Keep GITHUB_TOKEN private',
  });
  const projectPrivacy = screen.getByRole('switch', {
    name: 'Keep PROJECT_ID private',
  });
  const save = screen.getByRole('button', {
    name: 'Save 2 variables, share 1 with AI',
  });

  await expect.element(token).toHaveAttribute('type', 'password');
  await expect.element(projectId).toHaveAttribute('type', 'password');
  await expect.element(tokenPrivacy).toBeChecked();
  await expect.element(projectPrivacy).not.toBeChecked();
  await expect.element(save).toBeEnabled();
  await expect
    .element(screen.getByText(/plaintext value is sent to the AI/))
    .toBeVisible();
  await expect
    .element(screen.getByText(/1 value will be shared with the AI/))
    .toBeVisible();

  await projectPrivacy.click();
  await expect.element(projectPrivacy).toBeChecked();
  await expect
    .element(
      screen.getByRole('button', {
        name: 'Save 2 variables, share 0 with AI',
      }),
    )
    .toBeEnabled();
  await projectPrivacy.click();
  await expect.element(projectPrivacy).not.toBeChecked();

  await token.fill('github-private-value');
  await projectId.fill('public-project-id');
  await expect.element(save).toBeEnabled();

  const visibilityToggle = screen.getByRole('button', {
    name: 'Show value for GITHUB_TOKEN',
  });
  await visibilityToggle.click();
  await expect.element(token).toHaveAttribute('type', 'text');
  await expect
    .element(
      screen.getByRole('button', { name: 'Hide value for GITHUB_TOKEN' }),
    )
    .toBeVisible();

  await projectId.click();
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onSubmit).toHaveBeenCalledWith([
    { key: 'GITHUB_TOKEN', value: 'github-private-value', secret: true },
    { key: 'PROJECT_ID', value: 'public-project-id', secret: false },
  ]);
  await expect.element(token).toHaveValue('');
  await expect.element(projectId).toHaveValue('');
  expect(screen.getByRole('status').element().textContent).not.toContain(
    'github-private-value',
  );
  expect(screen.getByRole('status').element().textContent).not.toContain(
    'public-project-id',
  );
});

test('submits explicitly empty environment values', async () => {
  const onSubmit = vi.fn<(entries: EnvEntry[]) => Promise<boolean>>(
    async () => true,
  );
  const screen = await render(
    <MantineProvider>
      <EnvForm
        reason="Override an inherited environment value."
        variables={[variables[0]]}
        onSubmit={onSubmit}
      />
    </MantineProvider>,
  );

  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();

  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  expect(onSubmit).toHaveBeenCalledWith([
    { key: 'GITHUB_TOKEN', value: '', secret: true },
  ]);
});

test('blocks duplicate submits and retains values and privacy on failure', async () => {
  let finish: ((saved: boolean) => void) | undefined;
  const onSubmit = vi.fn<(entries: EnvEntry[]) => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <EnvForm
        reason="Connect the app to your account."
        variables={[variables[0]]}
        onSubmit={onSubmit}
      />
    </MantineProvider>,
  );
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  const privacy = screen.getByRole('switch', {
    name: 'Keep GITHUB_TOKEN private',
  });
  await privacy.click();
  const save = screen.getByRole('button', {
    name: 'Save 1 variable, share 1 with AI',
  });
  await input.fill('keep-this-value');

  await save.click();
  await expect.element(save).toBeDisabled();
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent('Saving 1 variable and sharing 1 value with the AI.');
  expect(
    screen.getByRole('status').element().closest('[aria-busy="true"]'),
  ).not.toBeNull();
  save.element().closest('form')?.requestSubmit();
  expect(onSubmit).toHaveBeenCalledOnce();

  finish?.(false);
  await expect.element(save).toBeEnabled();
  await expect.element(input).toHaveValue('keep-this-value');
  await expect.element(privacy).not.toBeChecked();
  await expect
    .element(screen.getByRole('status'))
    .toHaveTextContent(
      'Environment variables were not saved. Your values are still here.',
    );
  expect(screen.getByRole('status').element().textContent).not.toContain(
    'keep-this-value',
  );
});
