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
    path: '/app/$appSlug',
    component: () => null,
  });
  const manageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/$appSlug/manage',
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

function readFileCall(id: string, path: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'read_file',
    arguments: { path },
  };
}

function writeFileCall(
  id: string,
  path: string,
  content: string,
): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'write_file',
    arguments: { path, content },
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

const longReadPath = [
  'apps/customer-support/src/features',
  'notification-preferences-and-delivery-channels',
  `${'read-target-'.repeat(16)}settings.ts`,
].join('/');

const longWritePathSuffix = [
  'apps/customer-support/src/features',
  'notification-preferences-and-delivery-channels',
  `${'generated-config-'.repeat(16)}settings.ts`,
].join('/');
const attemptedWritePath = `/workspace/${longWritePathSuffix}`;
const canonicalWritePath = longWritePathSuffix;
const longWriteContents = [
  '  export const settings = {',
  '',
  `  token: '${'x'.repeat(240)}',`,
  ...Array.from({ length: 28 }, (_, index) => `  option${index}: ${index},`),
  '};',
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

function expectLeadingEllipsisDetail(header: Element, value: string) {
  const bidi = header.querySelector('bdi[dir="ltr"]');
  if (!(bidi instanceof HTMLElement)) {
    throw new TypeError('Expected a left-to-right path detail');
  }
  expect(bidi.textContent).toBe(value);

  const detail = bidi.parentElement;
  if (!detail) throw new TypeError('Expected a path detail container');
  const style = getComputedStyle(detail);
  expect(style.direction).toBe('rtl');
  expect(style.textAlign).toBe('left');
  expect(style.textOverflow).toBe('ellipsis');
  expect(detail.scrollWidth).toBeGreaterThan(detail.clientWidth);
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

test('keeps the tail of a persisted read path visible in a narrow header', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'read-long-path',
          name: 'read_file',
          arguments: { path: attemptedWritePath },
        },
      ],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'read-long-path',
          {
            role: 'toolResult',
            toolName: 'read_file',
            content: [{ type: 'text', text: 'file contents' }],
          },
        ],
      ]),
    },
  );

  const header = screen.getByRole('button', { name: /Read file/ }).element();
  expectLeadingEllipsisDetail(header, attemptedWritePath);
  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('keeps the tail of a completed live write path visible', async () => {
  const screen = await render(
    <MantineProvider>
      <Box data-testid="live-write-shell" w={320}>
        <StreamingToolStep
          tool={{
            id: 'write-long-path',
            name: 'write_file',
            args: { path: attemptedWritePath, content: 'contents' },
            done: true,
            output: `Wrote ${canonicalWritePath} (8 chars).`,
            details: { path: canonicalWritePath },
          }}
        />
      </Box>
    </MantineProvider>,
  );

  const header = screen.getByRole('button', { name: /Write file/ }).element();
  expectLeadingEllipsisDetail(header, attemptedWritePath);
  const shell = screen.getByTestId('live-write-shell').element();
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

test('shows every web search input in a persisted call', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'persisted-web-search',
        name: 'web_search',
        arguments: {
          exclude_domains: ['spam.example.com'],
          topic: 'news',
          query: 'latest battery research',
          include_domains: ['example.com', 'docs.example.com'],
          time_range: 'week',
          max_results: 10,
          search_depth: 'advanced',
        },
      },
    ],
  });

  await screen.getByRole('button', { name: /Web search/ }).click();
  const expected = [
    ['Query', 'latest battery research'],
    ['Maximum results', '10'],
    ['Search depth', 'advanced'],
    ['Topic', 'news'],
    ['Time range', 'week'],
    ['Include domains', '["example.com","docs.example.com"]'],
    ['Exclude domains', '["spam.example.com"]'],
  ] as const;
  for (const [label, value] of expected) {
    const region = screen.getByRole('region', { name: label });
    await expect.element(region).toBeVisible();
    expect(region.element().lastElementChild?.textContent).toBe(value);
  }
});

test('shows every web fetch input in a live call', async () => {
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'live-web-fetch',
          name: 'web_fetch',
          args: {
            extract_depth: 'advanced',
            query: 'pricing details',
            url: 'https://example.com/pricing',
          },
          done: false,
        }}
      />
    </MantineProvider>,
  );

  const expected = [
    ['URL', 'https://example.com/pricing'],
    ['Query', 'pricing details'],
    ['Extract depth', 'advanced'],
  ] as const;
  for (const [label, value] of expected) {
    const region = screen.getByRole('region', { name: label });
    await expect.element(region).toBeVisible();
    expect(region.element().lastElementChild?.textContent).toBe(value);
  }
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

test('reveals a persisted read path without overflowing a narrow message', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [readFileCall('read-persisted', longReadPath)],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'read-persisted',
          {
            role: 'toolResult',
            toolName: 'read_file',
            content: [{ type: 'text', text: 'export const value = true;\n' }],
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: /Read file/ }).click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const path = pathRegion.element().lastElementChild as HTMLElement;
  await expect.element(pathRegion).toBeVisible();
  expect(path.textContent).toBe(longReadPath);
  expect(getComputedStyle(path).overflowWrap).toBe('anywhere');
  expect(path.scrollWidth).toBeLessThanOrEqual(path.clientWidth);
  await expect
    .element(screen.getByRole('region', { name: 'Output' }))
    .toHaveTextContent('export const value = true;');

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('preserves a live read path through completion', async () => {
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'read-live',
          name: 'read_file',
          args: { path: longReadPath, offset: 20, limit: 100 },
          done: false,
          output: 'partial contents',
        }}
      />
    </MantineProvider>,
  );

  const runningPath = screen.getByRole('region', { name: 'File path' });
  await expect.element(runningPath).toBeVisible();
  expect(runningPath.element().lastElementChild?.textContent).toBe(
    longReadPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'Output' }))
    .toHaveTextContent('partial contents');

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'read-live',
          name: 'read_file',
          args: { path: longReadPath, offset: 20, limit: 100 },
          done: true,
          output: 'final contents',
        }}
      />
    </MantineProvider>,
  );

  expect(screen.getByRole('region', { name: 'File path' }).query()).toBeNull();
  const toggle = screen.getByRole('button', { name: /Read file/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  const completedPath = screen.getByRole('region', { name: 'File path' });
  await expect.element(completedPath).toBeVisible();
  expect(completedPath.element().lastElementChild?.textContent).toBe(
    longReadPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'Output' }))
    .toHaveTextContent('final contents');
});

test('reveals a successful persisted write without overflowing a narrow message', async () => {
  const summary = `Wrote ${canonicalWritePath} (${longWriteContents.length} chars).`;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        writeFileCall('write-persisted', attemptedWritePath, longWriteContents),
      ],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'write-persisted',
          {
            role: 'toolResult',
            toolName: 'write_file',
            content: [{ type: 'text', text: summary }],
            details: { path: canonicalWritePath },
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /Write file/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'true');

  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const contentsRegion = screen.getByRole('region', {
    name: 'File contents',
  });
  await expect.element(pathRegion).toBeVisible();
  await expect.element(contentsRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    canonicalWritePath,
  );

  const contents = contentsRegion.element().lastElementChild as HTMLElement;
  expect(contents.textContent).toBe(longWriteContents);
  const contentsStyle = getComputedStyle(contents);
  expect(contentsStyle.whiteSpace).toBe('pre-wrap');
  expect(contentsStyle.overflowWrap).toBe('anywhere');
  expect(contents.scrollWidth).toBeLessThanOrEqual(contents.clientWidth);
  expect(contents.scrollHeight).toBeGreaterThan(contents.clientHeight);
  expect(contents.clientHeight).toBeLessThanOrEqual(260);
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.textContent).not.toContain(summary);
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('keeps an incomplete empty write inspectable without an output', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [writeFileCall('write-incomplete', attemptedWritePath, '')],
  });

  await screen.getByRole('button', { name: /Write file/ }).click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const contentsRegion = screen.getByRole('region', {
    name: 'File contents',
  });
  await expect.element(pathRegion).toBeVisible();
  await expect.element(contentsRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    attemptedWritePath,
  );
  expect(contentsRegion.element().lastElementChild?.textContent).toBe(
    '(empty file)',
  );
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
});

test('preserves a live write from its attempted inputs to canonical completion', async () => {
  const content = '  first line\n\nlast line\n';
  const summary = `Wrote ${canonicalWritePath} (${content.length} chars).`;
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'write-live',
          name: 'write_file',
          args: { path: attemptedWritePath, content },
          done: false,
        }}
      />
    </MantineProvider>,
  );

  const runningPath = screen.getByRole('region', { name: 'File path' });
  const runningContents = screen.getByRole('region', {
    name: 'File contents',
  });
  await expect.element(runningPath).toBeVisible();
  await expect.element(runningContents).toBeVisible();
  expect(runningPath.element().lastElementChild?.textContent).toBe(
    attemptedWritePath,
  );
  expect(runningContents.element().lastElementChild?.textContent).toBe(content);
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'write-live',
          name: 'write_file',
          args: { path: attemptedWritePath, content },
          done: true,
          output: summary,
          details: { path: canonicalWritePath },
        }}
      />
    </MantineProvider>,
  );

  expect(screen.getByRole('region', { name: 'File path' }).query()).toBeNull();
  const toggle = screen.getByRole('button', { name: /Write file/ });
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();

  const completedPath = screen.getByRole('region', { name: 'File path' });
  const completedContents = screen.getByRole('region', {
    name: 'File contents',
  });
  await expect.element(completedPath).toBeVisible();
  await expect.element(completedContents).toBeVisible();
  expect(completedPath.element().lastElementChild?.textContent).toBe(
    canonicalWritePath,
  );
  expect(completedContents.element().lastElementChild?.textContent).toBe(
    content,
  );
  expect(screen.getByRole('region', { name: 'Output' }).query()).toBeNull();
  expect(document.body.textContent).not.toContain(summary);
});

test('keeps attempted write inputs and the output when a write fails', async () => {
  const content = 'new contents\n';
  const error = 'Parent path for the file is not a directory.';
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [writeFileCall('write-failed', attemptedWritePath, content)],
    },
    {
      toolResults: new Map([
        [
          'write-failed',
          {
            role: 'toolResult',
            toolName: 'write_file',
            content: [{ type: 'text', text: error }],
            details: { path: canonicalWritePath },
            isError: true,
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: /Write file/ }).click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const contentsRegion = screen.getByRole('region', {
    name: 'File contents',
  });
  const outputRegion = screen.getByRole('region', { name: 'Output' });
  await expect.element(pathRegion).toBeVisible();
  await expect.element(contentsRegion).toBeVisible();
  await expect.element(outputRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    attemptedWritePath,
  );
  expect(contentsRegion.element().lastElementChild?.textContent).toBe(content);
  await expect.element(outputRegion).toHaveTextContent(error);
});

test('keeps write output when historical inputs are unavailable', async () => {
  const legacy = await renderMessage({
    role: 'toolResult',
    toolName: 'write_file',
    content: [{ type: 'text', text: 'Legacy write completed.' }],
  });
  await legacy.getByRole('button', { name: /Write file/ }).click();
  await expect
    .element(legacy.getByText('Legacy write completed.'))
    .toBeVisible();
  await legacy.unmount();

  const missingContent = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'write-missing-content',
          name: 'write_file',
          arguments: { path: attemptedWritePath },
        },
      ],
    },
    {
      toolResults: new Map([
        [
          'write-missing-content',
          {
            role: 'toolResult',
            toolName: 'write_file',
            content: [{ type: 'text', text: 'Historical write completed.' }],
            details: { path: canonicalWritePath },
          },
        ],
      ]),
    },
  );
  await missingContent.getByRole('button', { name: /Write file/ }).click();
  const pathRegion = missingContent.getByRole('region', { name: 'File path' });
  const outputRegion = missingContent.getByRole('region', { name: 'Output' });
  await expect.element(pathRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    canonicalWritePath,
  );
  await expect
    .element(outputRegion.getByText('Historical write completed.'))
    .toBeVisible();
  expect(
    missingContent.getByRole('region', { name: 'File contents' }).query(),
  ).toBeNull();
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
  await expect.element(open).toHaveAttribute('href', '/app/todo');

  await screen.getByRole('button', { name: 'More actions for Todo' }).click();
  const manage = screen.getByRole('menuitem', { name: 'Manage app' });
  await expect.element(manage).toHaveAttribute('href', '/app/todo/manage');
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
  const open = group.getByRole('link', { name: 'Open' });
  await expect.element(open).toHaveAttribute('href', '/app/todo');
  const manage = group.getByRole('link', { name: 'Manage' }).all();
  expect(manage).toHaveLength(2);
  await expect.element(manage[0]).toHaveAttribute('href', '/app/worker/manage');
  await expect
    .element(manage[1])
    .toHaveAttribute('href', '/app/draft-app/manage');

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});
