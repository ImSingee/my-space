import { Box, MantineProvider } from '@mantine/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { userEvent } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageView } from './message-view';
import { StreamingToolStep } from './steps';
import type { AppListItem } from '~server/apps';
import type { EditFileDetails } from '~agent/edit-file-details';
import type { ChatMessage, ToolResultMessage, ToolCallBlock } from './types';

type RenderOptions = {
  width?: number;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  apps?: AppListItem[];
  toolResults?: Map<string, ToolResultMessage>;
  lastAssistantMessageStart?: number;
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
            lastAssistantMessageStart={options.lastAssistantMessageStart}
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

function runCommandCall(id: string, command: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'run_command',
    arguments: { command },
  };
}

const longCommand = [
  "  env MODE='full command' pnpm exec tsx <<'EOF'",
  'const payload = {',
  `  token: '${'x'.repeat(240)}',`,
  '};',
  ...Array.from(
    { length: 24 },
    (_, index) => `console.log(${index}, payload.token);`,
  ),
  'EOF',
  '',
].join('\n');

const longEditPathSuffix = [
  'apps/customer-support/src/features',
  'notification-preferences-and-delivery-channels',
  `${'nested-editor-'.repeat(16)}settings.tsx`,
].join('/');
const attemptedEditPath = `/workspace/${longEditPathSuffix}`;
const canonicalEditPath = longEditPathSuffix;

const editDetails: EditFileDetails = {
  path: canonicalEditPath,
  replacements: 1,
  diff: ' 1 const value = true;\n-2 const oldName = 1;\n+2 const newName = 1;\n   \\ No newline at end of file',
  patch:
    '--- src/app.ts\n+++ src/app.ts\n@@ -1,2 +1,2 @@\n const value = true;\n-const oldName = 1;\n+const newName = 1;',
  firstChangedLine: 2,
};

test('collapses finished work while keeping the final answer visible', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Planning the implementation.' },
        { type: 'text', text: 'I found the relevant component.' },
        {
          type: 'toolCall',
          id: 'read-chat',
          name: 'read_file',
          arguments: { path: 'src/components/agent/chat.tsx' },
        },
        {
          type: 'toolCall',
          id: 'edit-chat',
          name: 'edit_file',
          arguments: { path: 'src/components/agent/chat.tsx' },
        },
        { type: 'thinking', thinking: 'Verifying the finished change.' },
        { type: 'text', text: 'The conversation history now folds correctly.' },
      ],
      stopReason: 'stop',
    },
    {
      lastAssistantMessageStart: 4,
      toolResults: new Map([
        [
          'read-chat',
          {
            role: 'toolResult',
            toolName: 'read_file',
            content: [{ type: 'text', text: 'Read chat.tsx' }],
          },
        ],
        [
          'edit-chat',
          {
            role: 'toolResult',
            toolName: 'edit_file',
            content: [{ type: 'text', text: 'Edited chat.tsx' }],
          },
        ],
      ]),
    },
  );

  const showWork = screen.getByRole('button', { name: 'Show work' });
  await expect.element(showWork).toBeVisible();
  expect(showWork.element()).toHaveAttribute('aria-expanded', 'false');
  const contentId = showWork.element().getAttribute('aria-controls');
  expect(contentId).toBeTruthy();
  expect(document.getElementById(contentId!)).not.toBeNull();
  await expect
    .element(screen.getByText('The conversation history now folds correctly.'))
    .toBeVisible();
  await expect
    .element(screen.getByText('I found the relevant component.'))
    .not.toBeVisible();

  showWork.element().focus();
  await userEvent.keyboard('{Enter}');

  const hideWork = screen.getByRole('button', { name: 'Hide work' });
  expect(hideWork.element()).toHaveAttribute('aria-expanded', 'true');
  await expect
    .element(screen.getByText('I found the relevant component.'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: /Read file/ }))
    .toBeVisible();
  await screen.getByRole('button', { name: /Read file/ }).click();
  await expect.element(screen.getByText('Read chat.tsx')).toBeVisible();

  hideWork.element().focus();
  await userEvent.keyboard('{Space}');
  await expect
    .element(screen.getByRole('button', { name: 'Show work' }))
    .toBeVisible();
  await expect
    .element(screen.getByText('I found the relevant component.'))
    .not.toBeVisible();
});

test('does not add an empty disclosure to a pure final answer', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '   ' },
      { type: 'text', text: 'Nothing else needs to change.' },
    ],
    stopReason: 'stop',
  });

  await expect
    .element(screen.getByText('Nothing else needs to change.'))
    .toBeVisible();
  expect(screen.getByRole('button', { name: 'Show work' }).query()).toBeNull();
});

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
  await expect.element(partial).not.toBeVisible();
  await expect.element(notice).toBeVisible();
  await screen.getByRole('button', { name: 'Show work' }).click();
  await expect.element(partial).toBeVisible();
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

  await expect
    .element(screen.getByText('Work stopped here.'))
    .not.toBeVisible();
  await screen.getByRole('button', { name: 'Show work' }).click();
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

test('reveals a complete persisted command without overflowing a narrow message', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [runCommandCall('command-long', longCommand)],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'command-long',
          {
            role: 'toolResult',
            toolName: 'run_command',
            content: [{ type: 'text', text: 'Command finished.' }],
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: 'Show work' }).click();
  const toggle = screen.getByRole('button', { name: /Run command/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  const controlledId = toggle.element().getAttribute('aria-controls');
  expect(controlledId).toBeTruthy();
  expect(document.getElementById(controlledId as string)).not.toBeNull();
  toggle.element().focus();
  await userEvent.keyboard('{Enter}');
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'true');
  await userEvent.keyboard('{Space}');
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await userEvent.keyboard('{Space}');
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'true');

  const commandRegion = screen.getByRole('region', { name: 'Command' });
  const outputRegion = screen.getByRole('region', { name: 'Output' });
  await expect.element(commandRegion).toBeVisible();
  await expect.element(outputRegion).toBeVisible();
  const commandCode = commandRegion.element().lastElementChild;
  expect(commandCode).toBeInstanceOf(HTMLElement);
  expect(commandCode?.textContent).toBe(longCommand);
  const commandStyle = getComputedStyle(commandCode as HTMLElement);
  expect(commandStyle.whiteSpace).toBe('pre-wrap');
  expect(commandStyle.overflowWrap).toBe('anywhere');
  expect((commandCode as HTMLElement).scrollWidth).toBeLessThanOrEqual(
    (commandCode as HTMLElement).clientWidth,
  );
  expect((commandCode as HTMLElement).scrollHeight).toBeGreaterThan(
    (commandCode as HTMLElement).clientHeight,
  );
  expect((commandCode as HTMLElement).clientHeight).toBeLessThanOrEqual(260);
  await expect
    .element(outputRegion.getByText('Command finished.'))
    .toBeVisible();

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('keeps an incomplete persisted command expandable without a result', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [runCommandCall('command-incomplete', longCommand)],
  });

  await screen.getByRole('button', { name: 'Show work' }).click();
  await screen.getByRole('button', { name: /Run command/ }).click();
  const commandRegion = screen.getByRole('region', { name: 'Command' });
  await expect.element(commandRegion).toBeVisible();
  expect(commandRegion.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
});

test('shows the complete command while a live command is running', async () => {
  const screen = await render(
    <MantineProvider>
      <Box data-testid="live-command-shell" w={320}>
        <StreamingToolStep
          tool={{
            id: 'command-running',
            name: 'run_command',
            args: { command: longCommand },
            done: false,
          }}
        />
      </Box>
    </MantineProvider>,
  );

  const commandRegion = screen.getByRole('region', { name: 'Command' });
  await expect.element(commandRegion).toBeVisible();
  expect(commandRegion.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
  const shell = screen.getByTestId('live-command-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('collapses a live command after completion and preserves its details', async () => {
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'command-output',
          name: 'run_command',
          args: { command: longCommand },
          done: false,
          output: 'partial output',
        }}
      />
    </MantineProvider>,
  );

  const commandRegion = screen.getByRole('region', { name: 'Command' });
  const outputRegion = screen.getByRole('region', { name: 'Output' });
  await expect.element(commandRegion).toBeVisible();
  await expect.element(outputRegion).toBeVisible();
  expect(commandRegion.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
  await expect.element(outputRegion).toHaveTextContent('partial output');

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'command-output',
          name: 'run_command',
          args: { command: longCommand },
          done: true,
          output: 'final output',
        }}
      />
    </MantineProvider>,
  );

  const toggle = screen.getByRole('button', { name: /Run command/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  const controlledId = toggle.element().getAttribute('aria-controls');
  const collapsedBody = document.getElementById(controlledId as string);
  expect(collapsedBody).toHaveAttribute('aria-hidden', 'true');
  expect(collapsedBody).toHaveAttribute('inert');
  await vi.waitFor(() =>
    expect(getComputedStyle(collapsedBody as HTMLElement).display).toBe('none'),
  );
  expect(screen.getByRole('region', { name: 'Command' }).query()).toBeNull();
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
  await toggle.click();
  const completedCommand = screen.getByRole('region', { name: 'Command' });
  const completedOutput = screen.getByRole('region', { name: 'Output' });
  await expect.element(completedCommand).toBeVisible();
  await expect.element(completedOutput).toHaveTextContent('final output');
  expect(completedCommand.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
});

test('reveals a completed live command even when it produced no output', async () => {
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'command-done',
          name: 'run_command',
          args: { command: longCommand },
          done: true,
        }}
      />
    </MantineProvider>,
  );

  const toggle = screen.getByRole('button', { name: /Run command/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'true');
  const commandRegion = screen.getByRole('region', { name: 'Command' });
  await expect.element(commandRegion).toBeVisible();
  expect(commandRegion.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
  await expect
    .element(screen.getByRole('region', { name: 'Output' }))
    .toHaveTextContent('(no output)');
});

test('renders a persisted edit result as a colored diff', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'edit-app',
          name: 'edit_file',
          arguments: { path: attemptedEditPath },
        },
      ],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'edit-app',
          {
            role: 'toolResult',
            toolName: 'edit_file',
            content: [
              {
                type: 'text',
                text: `Edited ${canonicalEditPath}: replaced 1 occurrence(s).`,
              },
            ],
            details: editDetails,
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: 'Show work' }).click();
  await screen.getByRole('button', { name: /Edit file/ }).click();
  const fileRegion = screen.getByRole('region', { name: 'File path' });
  await expect.element(fileRegion).toBeVisible();
  const filePath = fileRegion.element().lastElementChild as HTMLElement;
  expect(filePath.textContent).toBe(canonicalEditPath);
  expect(getComputedStyle(filePath).overflowWrap).toBe('anywhere');
  expect(filePath.scrollWidth).toBeLessThanOrEqual(filePath.clientWidth);
  await expect
    .element(screen.getByRole('region', { name: 'File changes' }))
    .toBeVisible();
  const removed = screen.getByText('-2 const oldName = 1;');
  const added = screen.getByText('+2 const newName = 1;');
  await expect.element(removed).toBeVisible();
  await expect.element(added).toBeVisible();
  await expect
    .element(screen.getByText('\\ No newline at end of file'))
    .toBeVisible();
  expect(getComputedStyle(removed.element()).backgroundColor).not.toBe(
    getComputedStyle(added.element()).backgroundColor,
  );
  expect(document.body.textContent).not.toContain(
    `Edited ${canonicalEditPath}`,
  );
  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('preserves a live edit path from execution through its completed diff', async () => {
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'edit-live',
          name: 'edit_file',
          args: { path: attemptedEditPath },
          done: false,
        }}
      />
    </MantineProvider>,
  );

  const liveFile = screen.getByRole('region', { name: 'File path' });
  await expect.element(liveFile).toBeVisible();
  expect(liveFile.element().lastElementChild?.textContent).toBe(
    attemptedEditPath,
  );

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'edit-live',
          name: 'edit_file',
          args: { path: attemptedEditPath },
          done: true,
          output: `Edited ${canonicalEditPath}: replaced 1 occurrence(s).`,
          details: editDetails,
        }}
      />
    </MantineProvider>,
  );

  expect(screen.getByRole('region', { name: 'File path' }).query()).toBeNull();
  const toggle = screen.getByRole('button', { name: /Edit file/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const completedFile = screen.getByRole('region', { name: 'File path' });
  await expect.element(completedFile).toBeVisible();
  expect(completedFile.element().lastElementChild?.textContent).toBe(
    canonicalEditPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'File changes' }))
    .toBeVisible();
  await expect.element(screen.getByText('+2 const newName = 1;')).toBeVisible();
});

test('reveals the attempted path for an incomplete persisted edit', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'edit-incomplete',
        name: 'edit_file',
        arguments: { path: attemptedEditPath },
      },
    ],
  });

  await screen.getByRole('button', { name: 'Show work' }).click();
  await screen.getByRole('button', { name: /Edit file/ }).click();
  const fileRegion = screen.getByRole('region', { name: 'File path' });
  await expect.element(fileRegion).toBeVisible();
  expect(fileRegion.element().lastElementChild?.textContent).toBe(
    attemptedEditPath,
  );
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
  expect(
    screen.getByRole('region', { name: 'File changes' }).query(),
  ).toBeNull();
});

test('keeps the attempted path and error for a failed paired edit', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'edit-failed',
          name: 'edit_file',
          arguments: { path: attemptedEditPath },
        },
      ],
    },
    {
      toolResults: new Map([
        [
          'edit-failed',
          {
            role: 'toolResult',
            toolName: 'edit_file',
            content: [{ type: 'text', text: 'old_string was not found.' }],
            details: editDetails,
            isError: true,
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: 'Show work' }).click();
  await screen.getByRole('button', { name: /Edit file/ }).click();
  const fileRegion = screen.getByRole('region', { name: 'File path' });
  const outputRegion = screen.getByRole('region', { name: 'Output' });
  await expect.element(fileRegion).toBeVisible();
  expect(fileRegion.element().lastElementChild?.textContent).toBe(
    attemptedEditPath,
  );
  await expect
    .element(outputRegion.getByText('old_string was not found.'))
    .toBeVisible();
  expect(
    screen.getByRole('region', { name: 'File changes' }).query(),
  ).toBeNull();
});

test('falls back to result text for legacy and failed edit results', async () => {
  const legacy = await renderMessage({
    role: 'toolResult',
    toolName: 'edit_file',
    content: [{ type: 'text', text: 'Legacy edit completed.' }],
  });
  await legacy.getByRole('button', { name: /Edit file/ }).click();
  await expect
    .element(legacy.getByText('Legacy edit completed.'))
    .toBeVisible();
  expect(
    legacy.getByRole('region', { name: 'File changes' }).query(),
  ).toBeNull();
  await legacy.unmount();

  const failed = await renderMessage({
    role: 'toolResult',
    toolName: 'edit_file',
    content: [{ type: 'text', text: 'old_string was not found.' }],
    details: editDetails,
    isError: true,
  });
  await failed.getByRole('button', { name: /Edit file/ }).click();
  await expect
    .element(failed.getByText('old_string was not found.'))
    .toBeVisible();
  expect(
    failed.getByRole('region', { name: 'File changes' }).query(),
  ).toBeNull();
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
