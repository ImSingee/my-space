import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { appCompatibility } from '~/app-compatibility';
import { appTheme } from '~/ui/theme';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { AppCompatibilityNotice } from './app-compatibility-notice';

async function renderNotice(version: number) {
  return render(
    <MantineProvider theme={appTheme}>
      <AppCompatibilityNotice compatibility={appCompatibility(version)} />
    </MantineProvider>,
  );
}

test('shows a persistent redeploy prompt for supported legacy Apps', async () => {
  const screen = await renderNotice(1);

  await expect
    .element(screen.getByText('Compatibility update available'))
    .toBeVisible();
  await expect.element(screen.getByText(/uses compatibility v1/)).toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .toHaveAttribute('href', '/agent');
});

test('explains that an unsupported App runtime is disabled', async () => {
  const screen = await renderNotice(0);

  await expect.element(screen.getByText('App update required')).toBeVisible();
  await expect.element(screen.getByText(/runtime is disabled/)).toBeVisible();
});
