import { Box, MantineProvider } from '@mantine/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageView } from './message-view';
import type { AppListItem } from '~server/apps';
import type { ChatMessage, ToolResultMessage, ToolCallBlock } from './types';

type RenderOptions = {
  width?: number;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  apps?: AppListItem[];
  toolResults?: Map<string, ToolResultMessage>;
};

function renderMessage(message: ChatMessage, options: RenderOptions = {}) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <MantineProvider>
        <Box data-testid="message-shell" w={options.width}>
          <MessageView
            message={message}
            apps={options.apps}
            toolResults={options.toolResults}
            onRetry={options.onRetry}
            retrying={options.retrying}
            retryDisabled={options.retryDisabled}
          />
        </Box>
      </MantineProvider>
    ),
  });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/apps/$appId',
    component: () => null,
  });
  const manageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/apps/$appId/manage',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, appRoute, manageRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(<RouterProvider router={router as never} />);
}

const capabilities = (frontend: boolean) => ({
  database: false,
  frontend,
  widgets: false,
  backend: !frontend,
  cron: false,
  webhook: false,
  storage: false,
  kv: false,
  userscripts: false,
});

function appFixture(
  id: string,
  slug: string,
  name: string,
  overrides: Partial<AppListItem> = {},
): AppListItem {
  return {
    id,
    slug,
    name,
    description: null,
    status: 'deployed',
    capabilities: capabilities(true),
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function deployCall(id: string, appId: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'deploy_app',
    arguments: { id: appId },
  };
}

function deployResult(isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolName: 'deploy_app',
    content: [{ type: 'text', text: isError ? 'Build failed' : 'Deployed' }],
    isError,
  };
}

test('shows a persisted model error even when the reply has no content', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'OpenAI API error (402): 402 status code (no body)',
  });

  await expect
    .element(
      screen.getByRole('note', {
        name: "The Agent couldn't complete this reply",
      }),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText('OpenAI API error (402): 402 status code (no body)'),
    )
    .toBeVisible();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('shows Retry only when a callback is provided and invokes it', async () => {
  const onRetry = vi.fn<() => void>();
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider request failed.',
    },
    { onRetry },
  );

  const retry = screen.getByRole('button', { name: 'Retry' });
  await expect.element(retry).toBeVisible();
  await retry.click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('disables Retry and exposes its busy state while retrying', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider request failed.',
    },
    { onRetry: () => {}, retrying: true },
  );

  const retry = screen.getByRole('button', { name: 'Retry' });
  await expect.element(retry).toBeDisabled();
  expect(retry.element().getAttribute('aria-busy')).toBe('true');
});

test('keeps Retry visible but disabled when no model is available', async () => {
  const onRetry = vi.fn<() => void>();
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider request failed.',
    },
    { onRetry, retryDisabled: true },
  );

  const retry = screen.getByRole('button', { name: 'Retry' });
  await expect.element(retry).toBeVisible();
  await expect.element(retry).toBeDisabled();
  expect(retry.element()).not.toHaveAttribute('aria-busy');
  await retry.click({ force: true });
  expect(onRetry).not.toHaveBeenCalled();
});

test('does not show Retry when no callback is provided', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'Provider request failed.',
  });

  await expect.element(screen.getByRole('note')).toBeVisible();
  expect(document.querySelector('button')).toBeNull();
});

test('renders the terminal error after partial assistant content', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Partial answer before the provider failed.',
      },
    ],
    stopReason: 'error',
    errorMessage: 'Provider connection closed.',
  });

  const partial = screen.getByText(
    'Partial answer before the provider failed.',
  );
  const notice = screen.getByRole('note');
  await expect.element(partial).toBeVisible();
  await expect.element(notice).toBeVisible();
  expect(
    partial.element().compareDocumentPosition(notice.element()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test('does not present an aborted reply as an error', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Work stopped here.' }],
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
  });

  await expect.element(screen.getByText('Work stopped here.')).toBeVisible();
  expect(document.querySelector('[role="note"]')).toBeNull();
  expect(
    document.body.textContent?.includes(
      "The Agent couldn't complete this reply",
    ),
  ).toBe(false);
});

test('uses a useful fallback when an error has no detail', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [],
    stopReason: 'error',
  });

  await expect
    .element(screen.getByText('The model provider returned an unknown error.'))
    .toBeVisible();
});

test('renders a persisted file attachment with a download link', async () => {
  const screen = await renderMessage({
    role: 'user',
    content: [{ type: 'text', text: 'See the file' }],
    attachments: [
      {
        id: 'attachment-a',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 2048,
      },
    ],
  });

  const link = screen.getByTitle('report.pdf (2.0 KB)');
  await expect.element(link).toBeVisible();
  expect(link.element()).toHaveAttribute(
    'href',
    '/api/agent/attachments/attachment-a',
  );
  expect(link.element()).toHaveAttribute('download', 'report.pdf');
  await expect.element(screen.getByText('See the file')).toBeVisible();
});

test('wraps long and multiline provider errors inside a narrow message', async () => {
  const longToken = `provider-${'x'.repeat(320)}`;
  const error = `First line\n${longToken}`;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: error,
    },
    { width: 320, onRetry: () => {} },
  );

  const detail = screen.getByText(error);
  await expect.element(detail).toBeVisible();

  const detailElement = detail.element();
  const shell = screen.getByTestId('message-shell').element();
  expect(getComputedStyle(detailElement).whiteSpace).toBe('pre-wrap');
  expect(getComputedStyle(detailElement).overflowWrap).toBe('anywhere');
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('renders one successful frontend deploy with Open and a Manage menu', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [deployCall('deploy-todo', 'todo')],
    },
    {
      apps: [appFixture('app-todo', 'todo', 'Todo')],
      toolResults: new Map([['deploy-todo', deployResult()]]),
    },
  );

  await expect.element(screen.getByText('Deployed app')).toBeVisible();
  await expect.element(screen.getByText('Todo', { exact: true })).toBeVisible();
  const open = screen.getByRole('link', { name: 'Open' });
  await expect.element(open).toHaveAttribute('href', '/apps/app-todo');

  await screen.getByRole('button', { name: 'More actions for Todo' }).click();
  const manage = screen.getByRole('menuitem', { name: 'Manage app' });
  await expect.element(manage).toHaveAttribute('href', '/apps/app-todo/manage');
});

test('groups successful deploys, resolves aliases, and uses state-aware actions', async () => {
  const calls = [
    deployCall('todo-by-id', 'app-todo'),
    deployCall('worker', 'worker'),
    deployCall('todo-by-slug', 'todo'),
    deployCall('failed', 'failed-app'),
    deployCall('draft', 'draft-app'),
    deployCall('deleted', 'deleted-app'),
  ];
  const toolResults = new Map(
    calls.map((call) => [call.id, deployResult(call.id === 'failed')]),
  );
  const screen = await renderMessage(
    { role: 'assistant', content: calls },
    {
      width: 300,
      apps: [
        appFixture('app-todo', 'todo', 'Todo'),
        appFixture('app-worker', 'worker', 'Background Worker', {
          capabilities: capabilities(false),
        }),
        appFixture('app-draft', 'draft-app', 'Draft App', {
          status: 'draft',
        }),
      ],
      toolResults,
    },
  );

  const group = screen.getByRole('region', { name: 'Deployed apps' });
  await expect.element(group.getByText('Deployed apps · 4')).toBeVisible();
  expect(group.getByText('Todo', { exact: true }).all()).toHaveLength(1);
  await expect.element(group.getByText('Background Worker')).toBeVisible();
  await expect.element(group.getByText('Draft App')).toBeVisible();
  await expect.element(group.getByText('deleted-app')).toBeVisible();
  await expect.element(group.getByText('Unavailable')).toBeVisible();
  expect(group.getByRole('link', { name: 'Open' }).all()).toHaveLength(1);
  expect(group.getByRole('link', { name: 'Manage' }).all()).toHaveLength(2);

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});
