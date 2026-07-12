import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Composer } from './composer';

test('allows only one asynchronous submission at a time', async () => {
  let finish: ((accepted: boolean) => void) | undefined;
  const onSubmit = vi.fn<() => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = screen.getByPlaceholder('Message the Agent…');
  await input.fill('Send once');
  const send = screen.getByRole('button', { name: 'Send' });

  await send.click();
  await expect.element(send).toBeDisabled();
  input
    .element()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );

  expect(onSubmit).toHaveBeenCalledOnce();
  finish?.(true);
  await expect.element(input).toHaveValue('');
});

test('keeps only attachments added while an accepted send is pending', async () => {
  let finish: ((accepted: boolean) => void) | undefined;
  const onSubmit = vi.fn<() => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const attach = (name: string) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([name], name, { type: 'application/octet-stream' }),
    );
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: transfer.files,
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  attach('submitted.bin');
  await expect.element(screen.getByText('submitted.bin')).toBeVisible();
  await screen.getByRole('button', { name: 'Send' }).click();
  attach('new-draft.bin');
  await expect.element(screen.getByText('new-draft.bin')).toBeVisible();

  finish?.(true);
  await expect
    .element(screen.getByText('submitted.bin'))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText('new-draft.bin')).toBeVisible();
  expect(onSubmit).toHaveBeenCalledOnce();
});

test('rejects empty files before they enter the draft', async () => {
  const onSubmit = vi.fn<() => void>();
  const screen = await render(
    <MantineProvider>
      <Composer onSubmit={onSubmit} />
    </MantineProvider>,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const transfer = new DataTransfer();
  transfer.items.add(new File([], 'empty.txt', { type: 'text/plain' }));
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: transfer.files,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await expect.element(screen.getByText('empty.txt')).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole('button', { name: 'Send' }))
    .toBeDisabled();
  expect(onSubmit).not.toHaveBeenCalled();
});
