import { MantineProvider } from '@mantine/core';
import { createElement, type ReactNode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { WorkflowDetail } from '~server/workflows';
import { appTheme } from '~/ui/theme';

const mocks = vi.hoisted(() => ({
  workflow: null as WorkflowDetail | null,
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    createFileRoute: () => (options: object) => ({
      ...options,
      useLoaderData: () => mocks.workflow,
    }),
    Link: ({ children, to, ...props }: { children: ReactNode; to?: string }) =>
      createElement('a', { href: to, ...props }, children),
  };
});

vi.mock('~components/workflows/trigger-form', () => ({
  TriggerForm: () =>
    createElement('div', { 'data-testid': 'trigger-form' }, 'Run Workflow'),
}));

vi.mock('~server/workflows', () => ({
  getWorkflowBySlug: vi.fn<() => void>(),
}));

import { WorkflowRunPage } from '~/routes/_app/workflow/$workflowSlug';

function workflow(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: 'workflow-one',
    slug: 'workflow-one',
    name: 'Example Workflow',
    description: null,
    status: 'deployed',
    pinned: true,
    currentDeploymentId: 'deployment-one',
    currentSourceCommit: 'commit-one',
    compatibility: {
      version: 1,
      latestVersion: 1,
      minimumSupportedVersion: 1,
      isSupported: true,
      isLatest: true,
    },
    inputSchema: { type: 'object' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

async function renderRunPage() {
  return render(
    <MantineProvider theme={appTheme}>
      <WorkflowRunPage />
    </MantineProvider>,
  );
}

beforeEach(() => {
  mocks.workflow = workflow();
});

test('renders the run form for a supported deployment', async () => {
  const screen = await renderRunPage();

  await expect.element(screen.getByTestId('trigger-form')).toBeVisible();
});

test('routes a below-minimum deployment to Agent without rendering the form', async () => {
  mocks.workflow = workflow({
    compatibility: {
      version: 0,
      latestVersion: 1,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const screen = await renderRunPage();

  expect(
    screen.container.querySelector('[data-testid="trigger-form"]'),
  ).toBeNull();
  await expect
    .element(screen.getByText('Workflow update required'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .toHaveAttribute('href', '/agent');
});

test('requires a platform update for a newer deployment', async () => {
  mocks.workflow = workflow({
    compatibility: {
      version: 2,
      latestVersion: 1,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const screen = await renderRunPage();

  expect(
    screen.container.querySelector('[data-testid="trigger-form"]'),
  ).toBeNull();
  await expect
    .element(screen.getByText('Platform update required'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Agent' }))
    .not.toBeInTheDocument();
});

test('requires redeploy when the active deployment record is unavailable', async () => {
  mocks.workflow = workflow({ compatibility: null });

  const screen = await renderRunPage();

  expect(
    screen.container.querySelector('[data-testid="trigger-form"]'),
  ).toBeNull();
  await expect
    .element(screen.getByText(/active deployment record is unavailable/))
    .toBeVisible();
});
