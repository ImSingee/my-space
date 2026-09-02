import { MantineProvider } from '@mantine/core';
import type { ReactNode } from 'react';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { WorkflowCompatibilityNotice } from './workflow-compatibility-notice';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

test('directs a newer Workflow compatibility version to a platform update', async () => {
  const screen = await render(
    <MantineProvider>
      <WorkflowCompatibilityNotice
        compatibility={{
          version: 2,
          latestVersion: 1,
          minimumSupportedVersion: 1,
          isSupported: false,
          isLatest: false,
        }}
      />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByText('Platform update required'))
    .toBeVisible();
  await expect
    .element(screen.getByText(/newer than this platform's latest supported v1/))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .not.toBeInTheDocument();
});

test('routes a below-minimum Workflow compatibility version to Agent', async () => {
  const screen = await render(
    <MantineProvider>
      <WorkflowCompatibilityNotice
        compatibility={{
          version: 0,
          latestVersion: 1,
          minimumSupportedVersion: 1,
          isSupported: false,
          isLatest: false,
        }}
      />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByText('Workflow update required'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .toHaveAttribute('href', '/agent');
});

test('keeps a supported older Workflow running while offering an update', async () => {
  const screen = await render(
    <MantineProvider>
      <WorkflowCompatibilityNotice
        compatibility={{
          version: 1,
          latestVersion: 2,
          minimumSupportedVersion: 1,
          isSupported: true,
          isLatest: false,
        }}
      />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByText('Compatibility update available'))
    .toBeVisible();
  await expect.element(screen.getByText(/It can keep running/)).toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .toHaveAttribute('href', '/agent');
});
