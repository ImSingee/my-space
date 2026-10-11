import { Box, MantineProvider } from '@mantine/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { type Locator, page, userEvent } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageView } from './message-view';
import { StreamingToolStep } from './steps';
import type { AppListItem } from '~server/apps';
import type { EditFileDetails } from '~agent/edit-file-details';
import type { WorkflowListItem } from '~server/workflows';
import type { ChatMessage, ToolResultMessage, ToolCallBlock } from './types';

type RenderOptions = {
  width?: number;
  onRetry?: () => void;
  retrying?: boolean;
  retryDisabled?: boolean;
  apps?: AppListItem[];
  workflows?: WorkflowListItem[];
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
            workflows={options.workflows}
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
  const workflowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflow/$workflowSlug',
    component: () => null,
  });
  const workflowManageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflow/$workflowSlug/manage',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      appRoute,
      manageRoute,
      workflowRoute,
      workflowManageRoute,
    ]),
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

function workflowFixture(
  id: string,
  slug: string,
  name: string,
  overrides: Partial<WorkflowListItem> = {},
): WorkflowListItem {
  return {
    id,
    slug,
    name,
    description: null,
    status: 'deployed',
    pinned: false,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function deployWorkflowCall(id: string, workflowId: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'deploy_workflow',
    arguments: { id: workflowId },
  };
}

function deployWorkflowResult(isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolName: 'deploy_workflow',
    content: [{ type: 'text', text: isError ? 'Build failed' : 'Deployed' }],
    isError,
  };
}

function runCommandCall(
  id: string,
  command: string,
  purpose?: string,
): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'run_command',
    arguments: { command, ...(purpose === undefined ? {} : { purpose }) },
  };
}

function readFileCall(
  id: string,
  path: string,
  options: { offset?: number; limit?: number } = {},
): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'read_file',
    arguments: { path, ...options },
  };
}

function listFilesCall(id: string, path?: string): ToolCallBlock {
  return {
    type: 'toolCall',
    id,
    name: 'list_files',
    arguments: path === undefined ? {} : { path },
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
const absoluteReadPath = `/workspace/${longReadPath}`;

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
  relativePath: canonicalEditPath,
  absolutePath: attemptedEditPath,
  replacements: 1,
  diff: ' 1 const value = true;\n-2 const oldName = 1;\n+2 const newName = 1;\n   \\ No newline at end of file',
  patch:
    '--- src/app.ts\n+++ src/app.ts\n@@ -1,2 +1,2 @@\n const value = true;\n-const oldName = 1;\n+const newName = 1;',
  firstChangedLine: 2,
};

function expectPathDetail(header: Element, value: string): HTMLElement {
  const bidi = header.querySelector('bdi[dir="ltr"]');
  if (!(bidi instanceof HTMLElement)) {
    throw new TypeError('Expected a left-to-right path detail');
  }
  expect(bidi.textContent).toBe(value);

  return bidi;
}

function expectLeadingEllipsisDetail(header: Element, value: string) {
  const bidi = expectPathDetail(header, value);

  const detail = bidi.parentElement;
  if (!detail) throw new TypeError('Expected a path detail container');
  const style = getComputedStyle(detail);
  expect(style.direction).toBe('rtl');
  expect(style.textAlign).toBe('left');
  expect(style.textOverflow).toBe('ellipsis');
  expect(detail.scrollWidth).toBeGreaterThan(detail.clientWidth);
}

function sectionText(region: Locator): string {
  const contents = region.element().lastElementChild;
  if (!(contents instanceof HTMLElement)) {
    throw new TypeError('Expected labeled section contents');
  }
  return contents.textContent ?? '';
}

function expectRequest(region: Locator, args: unknown) {
  expect(JSON.parse(sectionText(region))).toStrictEqual(args);
}

function expectInDocumentOrder(...elements: Element[]) {
  for (let index = 1; index < elements.length; index += 1) {
    expect(
      elements[index - 1].compareDocumentPosition(elements[index]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

/** Expand a collapsed step and scope queries to its details. */
async function expandStep(toggle: Locator): Promise<Locator> {
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  expect(toggle.element()).toHaveAttribute('aria-expanded', 'true');
  const body = document.getElementById(
    toggle.element().getAttribute('aria-controls') ?? '',
  );
  if (!body) throw new TypeError('Expected the expanded step details');
  return page.elementLocator(body);
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

test('renders resource snapshots as @ mentions instead of internal model text', async () => {
  const internal =
    'Review @APP{name="Original Name" id="app-stable" slug="original-slug"}' +
    ' with @WORKFLOW{name="Original Workflow" id="workflow-stable"} now.';
  const screen = await renderMessage({
    role: 'user',
    content: [{ type: 'text', text: internal }],
    composerContent: [
      { type: 'text', text: 'Review ' },
      {
        type: 'app',
        id: 'app-stable',
        name: 'Original Name',
        slug: 'original-slug',
      },
      { type: 'text', text: ' with ' },
      {
        type: 'workflow',
        id: 'workflow-stable',
        name: 'Original Workflow',
      },
      { type: 'text', text: ' now.' },
    ],
  });

  await expect.element(screen.getByText('@Original Name')).toBeVisible();
  await expect.element(screen.getByText('@Original Workflow')).toBeVisible();
  expect(screen.getByTestId('message-shell').element().textContent).toBe(
    'Review @Original Name with @Original Workflow now.',
  );
  expect(document.body.textContent).not.toContain(internal);
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
            details: {
              path: canonicalWritePath,
              relativePath: canonicalWritePath,
              absolutePath: attemptedWritePath,
            },
          }}
        />
      </Box>
    </MantineProvider>,
  );

  const header = screen.getByRole('button', { name: /Write file/ }).element();
  expectLeadingEllipsisDetail(header, canonicalWritePath);
  const shell = screen.getByTestId('live-write-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('reveals a complete persisted command without overflowing a narrow message', async () => {
  const purpose = `Inspect ${'a very long command purpose '.repeat(8)}`;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [runCommandCall('command-long', longCommand, purpose)],
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

  const toggle = screen.getByRole('button', { name: new RegExp(purpose) });
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
  const requestRegion = screen.getByRole('region', { name: 'Request' });
  await expect.element(requestRegion).toBeVisible();
  expectRequest(requestRegion, { command: longCommand, purpose });
  expectInDocumentOrder(
    commandRegion.element(),
    requestRegion.element(),
    outputRegion.element(),
  );

  const shell = screen.getByTestId('message-shell').element();
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
  const purpose = '  Run\nproject   checks  ';
  const screen = await render(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'command-output',
          name: 'run_command',
          label: 'Run command',
          args: { purpose, command: longCommand },
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
  await expect.element(outputRegion).toMatchTextContent('partial output');

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'command-output',
          name: 'run_command',
          label: 'Run command',
          args: { purpose, command: longCommand },
          done: true,
          output: 'final output',
        }}
      />
    </MantineProvider>,
  );

  const toggle = screen.getByRole('button', {
    name: /Run project checks/,
  });
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
  await expect.element(completedOutput).toMatchTextContent('final output');
  expect(completedCommand.element().lastElementChild?.textContent).toBe(
    longCommand,
  );
});

test('falls back to Run command for a persisted legacy call', async () => {
  const screen = await renderMessage({
    role: 'assistant',
    content: [runCommandCall('legacy-command', 'pwd')],
  });

  await expect
    .element(screen.getByRole('button', { name: /Run command/ }))
    .toBeVisible();
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
            details: {
              path: longReadPath,
              relativePath: longReadPath,
              absolutePath: absoluteReadPath,
            },
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /Read file/ });
  expectLeadingEllipsisDetail(toggle.element(), longReadPath);
  await toggle.click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const path = pathRegion.element().lastElementChild as HTMLElement;
  await expect.element(pathRegion).toBeVisible();
  expect(path.textContent).toBe(absoluteReadPath);
  expect(getComputedStyle(path).overflowWrap).toBe('anywhere');
  expect(path.scrollWidth).toBeLessThanOrEqual(path.clientWidth);
  expectRequest(screen.getByRole('region', { name: 'Request' }), {
    path: longReadPath,
  });
  await expect
    .element(screen.getByRole('region', { name: 'File contents' }))
    .toMatchTextContent('export const value = true;');

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
          details: {
            relativePath: longReadPath,
            absolutePath: absoluteReadPath,
          },
          done: false,
          output: 'partial contents',
        }}
      />
    </MantineProvider>,
  );

  const runningPath = screen.getByRole('region', { name: 'File path' });
  await expect.element(runningPath).toBeVisible();
  expect(runningPath.element().lastElementChild?.textContent).toBe(
    absoluteReadPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'File contents' }))
    .toMatchTextContent('partial contents');

  await screen.rerender(
    <MantineProvider>
      <StreamingToolStep
        tool={{
          id: 'read-live',
          name: 'read_file',
          args: { path: longReadPath, offset: 20, limit: 100 },
          done: true,
          output: 'final contents',
          details: {
            relativePath: longReadPath,
            absolutePath: absoluteReadPath,
          },
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
    absoluteReadPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'File contents' }))
    .toMatchTextContent('final contents');
});

test('expands a listed directory with stable path and contents labels', async () => {
  const listPath = longReadPath.slice(0, longReadPath.lastIndexOf('/'));
  const absoluteListPath = `/workspace/${listPath}`;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [listFilesCall('list-persisted', absoluteListPath)],
    },
    {
      width: 320,
      toolResults: new Map([
        [
          'list-persisted',
          {
            role: 'toolResult',
            toolName: 'list_files',
            content: [{ type: 'text', text: '- main.ts\nd components' }],
            details: {
              path: listPath,
              relativePath: listPath,
              absolutePath: absoluteListPath,
            },
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /List files/ });
  expectLeadingEllipsisDetail(toggle.element(), listPath);
  await toggle.click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  const contentsRegion = screen.getByRole('region', {
    name: 'Directory contents',
  });
  await expect.element(pathRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    absoluteListPath,
  );
  await expect.element(contentsRegion).toMatchTextContent('- main.ts');
  await expect.element(contentsRegion).toMatchTextContent('d components');
  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('normalizes a legacy root listing path to the workspace root', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [listFilesCall('list-legacy-root')],
    },
    {
      toolResults: new Map([
        [
          'list-legacy-root',
          {
            role: 'toolResult',
            toolName: 'list_files',
            content: [{ type: 'text', text: '- package.json' }],
            details: { path: '', count: 1 },
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /List files/ });
  expectPathDetail(toggle.element(), '.');
  await toggle.click();
  const pathRegion = screen.getByRole('region', { name: 'File path' });
  await expect.element(pathRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe('.');
  expect(pathRegion.element().textContent).not.toContain('(empty file path)');
  expect(sectionText(screen.getByRole('region', { name: 'Request' }))).toBe(
    '{}',
  );
});

test('does not show the workspace root for an invalid persisted list path', async () => {
  const error = 'Invalid arguments for tool list_files: path must be a string';
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'list-invalid-null',
          name: 'list_files',
          arguments: { path: null },
        },
      ],
    },
    {
      toolResults: new Map([
        [
          'list-invalid-null',
          {
            role: 'toolResult',
            toolName: 'list_files',
            content: [{ type: 'text', text: error }],
            isError: true,
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /List files/ });
  expect(toggle.element().querySelector('bdi')).toBeNull();
  await toggle.click();
  expect(screen.getByRole('region', { name: 'File path' }).query()).toBeNull();
  expectRequest(screen.getByRole('region', { name: 'Request' }), {
    path: null,
  });
  await expect
    .element(screen.getByRole('region', { name: 'Error' }))
    .toMatchTextContent(error);
});

test('labels an empty read result as empty file contents', async () => {
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [readFileCall('read-empty', 'empty.txt')],
    },
    {
      toolResults: new Map([
        [
          'read-empty',
          {
            role: 'toolResult',
            toolName: 'read_file',
            content: [{ type: 'text', text: '' }],
            details: {
              relativePath: 'empty.txt',
              absolutePath: '/workspace/empty.txt',
            },
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: /Read file/ }).click();
  await expect
    .element(screen.getByRole('region', { name: 'File contents' }))
    .toMatchTextContent('(empty file)');
});

test('distinguishes an empty read page from an empty file', async () => {
  const offset = 128;
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        readFileCall('read-empty-page', 'non-empty.txt', {
          offset,
          limit: 64,
        }),
      ],
    },
    {
      toolResults: new Map([
        [
          'read-empty-page',
          {
            role: 'toolResult',
            toolName: 'read_file',
            content: [{ type: 'text', text: '' }],
            details: {
              relativePath: 'non-empty.txt',
              absolutePath: '/workspace/non-empty.txt',
              offset,
              limit: 64,
              truncated: false,
            },
          },
        ],
      ]),
    },
  );

  await screen.getByRole('button', { name: /Read file/ }).click();
  const contents = screen.getByRole('region', { name: 'File contents' });
  await expect
    .element(contents)
    .toMatchTextContent('(no content at offset 128)');
  expect(contents.element().textContent).not.toContain('(empty file)');
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
            details: {
              path: canonicalWritePath,
              relativePath: canonicalWritePath,
              absolutePath: attemptedWritePath,
            },
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /Write file/ });
  expectLeadingEllipsisDetail(toggle.element(), canonicalWritePath);
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
    attemptedWritePath,
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
          details: {
            relativePath: canonicalWritePath,
            absolutePath: attemptedWritePath,
          },
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
  expectRequest(screen.getByRole('region', { name: 'Request' }), {
    path: attemptedWritePath,
    content,
  });
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
          details: {
            path: canonicalWritePath,
            relativePath: canonicalWritePath,
            absolutePath: attemptedWritePath,
          },
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
    attemptedWritePath,
  );
  expect(completedContents.element().lastElementChild?.textContent).toBe(
    content,
  );
  expectRequest(screen.getByRole('region', { name: 'Request' }), {
    path: attemptedWritePath,
    content,
  });
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
            details: {
              relativePath: canonicalWritePath,
              absolutePath: attemptedWritePath,
            },
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
  const outputRegion = screen.getByRole('region', { name: 'Error' });
  await expect.element(pathRegion).toBeVisible();
  await expect.element(contentsRegion).toBeVisible();
  await expect.element(outputRegion).toBeVisible();
  expect(pathRegion.element().lastElementChild?.textContent).toBe(
    attemptedWritePath,
  );
  expect(contentsRegion.element().lastElementChild?.textContent).toBe(content);
  await expect.element(outputRegion).toMatchTextContent(error);
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

  const toggle = screen.getByRole('button', { name: /Edit file/ });
  expectLeadingEllipsisDetail(toggle.element(), canonicalEditPath);
  await toggle.click();
  const fileRegion = screen.getByRole('region', { name: 'File path' });
  await expect.element(fileRegion).toBeVisible();
  const filePath = fileRegion.element().lastElementChild as HTMLElement;
  expect(filePath.textContent).toBe(attemptedEditPath);
  expect(getComputedStyle(filePath).overflowWrap).toBe('anywhere');
  expect(filePath.scrollWidth).toBeLessThanOrEqual(filePath.clientWidth);
  const changes = screen.getByRole('region', { name: 'File changes' });
  await expect.element(changes).toBeVisible();
  const requestRegion = screen.getByRole('region', { name: 'Request' });
  expectRequest(requestRegion, { path: attemptedEditPath });
  expectInDocumentOrder(requestRegion.element(), changes.element());
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
          details: {
            relativePath: canonicalEditPath,
            absolutePath: attemptedEditPath,
          },
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
    attemptedEditPath,
  );
  await expect
    .element(screen.getByRole('region', { name: 'File changes' }))
    .toBeVisible();
  await expect.element(screen.getByText('+2 const newName = 1;')).toBeVisible();
});

test('keeps the attempted edit request and error for a failed paired edit', async () => {
  const args = {
    path: attemptedEditPath,
    old_string: '  const oldName = 1;\n\treturn oldName;\n',
    new_string: '',
    replace_all: false,
  };
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'edit-failed',
          name: 'edit_file',
          arguments: args,
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
  const outputRegion = screen.getByRole('region', { name: 'Error' });
  await expect.element(fileRegion).toBeVisible();
  expect(fileRegion.element().lastElementChild?.textContent).toBe(
    attemptedEditPath,
  );
  await expect
    .element(outputRegion.getByText('old_string was not found.'))
    .toBeVisible();
  const requestRegion = screen.getByRole('region', { name: 'Request' });
  await expect.element(requestRegion).toBeVisible();
  expectRequest(requestRegion, args);
  expectInDocumentOrder(
    fileRegion.element(),
    requestRegion.element(),
    outputRegion.element(),
  );
  expect(
    screen.getByRole('region', { name: 'File changes' }).query(),
  ).toBeNull();
});

test('shows the complete request beside a failed KV error', async () => {
  const args = {
    id: 'app-kv',
    action: 'list',
    key: '',
    cursor: '',
    limit: 0,
    secret: false,
    reveal_secrets: false,
    value: null,
    unexpected: { nested: [1, 'two', { deep: true }], empty: [] },
  };
  const error =
    'Invalid arguments for tool query_app_kv: cursor must not be empty';
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'kv-failed',
          name: 'query_app_kv',
          arguments: args,
        },
      ],
    },
    {
      toolResults: new Map([
        [
          'kv-failed',
          {
            role: 'toolResult',
            toolName: 'query_app_kv',
            content: [{ type: 'text', text: error }],
            isError: true,
          },
        ],
      ]),
    },
  );

  const toggle = screen.getByRole('button', { name: /Query app KV/ });
  expect(toggle.element().textContent).not.toContain('"cursor"');
  expect(screen.getByRole('region', { name: 'Request' }).query()).toBeNull();
  const details = await expandStep(toggle);
  const requestRegion = details.getByRole('region', { name: 'Request' });
  const errorRegion = details.getByRole('region', { name: 'Error' });
  await expect.element(requestRegion).toBeVisible();
  await expect.element(errorRegion).toMatchTextContent(error);
  expectRequest(requestRegion, args);
  expect(sectionText(requestRegion)).toContain('\n  "cursor": "",\n');
  expect(sectionText(errorRegion)).not.toContain('"cursor"');
  expectInDocumentOrder(requestRegion.element(), errorRegion.element());
});

test('shows structured Data Table and SQL requests within a narrow message', async () => {
  const longToken = `tok_${'x'.repeat(480)}`;
  const dataTableArgs = {
    id: 'app-crm',
    action: 'mutate',
    table: 'contacts',
    where: [
      { field: 'email', op: 'eq', value: longToken },
      { field: 'archived', op: 'eq', value: false },
      { field: 'score', op: 'gte', value: 0 },
      { field: 'tags', op: 'in', value: ['vip', ''] },
    ],
    order_by: { field: 'created_at', direction: 'desc' },
    cursor: '',
    limit: 25,
    operations: [
      {
        type: 'insert',
        table: 'contacts',
        value: { name: 'Ada', meta: { source: null, notes: '' } },
      },
      {
        type: 'update',
        table: 'contacts',
        id: 'row-1',
        value: { name: 'Grace' },
        unset: ['nickname'],
      },
      {
        type: 'increment',
        table: 'counters',
        id: 'row-2',
        field: 'visits',
        amount: -1,
      },
    ],
    timeout_ms: 1500,
  };
  const sql = [
    'SELECT id, email',
    'FROM contacts',
    `WHERE email = '${longToken}'`,
    ...Array.from({ length: 24 }, (_, index) => `  AND tag_${index} > 0`),
    'ORDER BY created_at DESC;',
  ].join('\n');
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'data-table',
          name: 'query_app_data_table',
          arguments: dataTableArgs,
        },
        {
          type: 'toolCall',
          id: 'sql',
          name: 'query_app_db',
          arguments: { id: 'app-crm', sql },
        },
      ],
    },
    {
      width: 320,
      toolResults: new Map<string, ToolResultMessage>([
        [
          'data-table',
          {
            role: 'toolResult',
            toolName: 'query_app_data_table',
            content: [{ type: 'text', text: 'Applied 3 operations.' }],
          },
        ],
        [
          'sql',
          {
            role: 'toolResult',
            toolName: 'query_app_db',
            content: [{ type: 'text', text: 'column "tag_0" does not exist' }],
            isError: true,
          },
        ],
      ]),
    },
  );

  const tableDetails = await expandStep(
    screen.getByRole('button', { name: /Query app Data Table/ }),
  );
  const tableRequest = tableDetails.getByRole('region', { name: 'Request' });
  await expect.element(tableRequest).toBeVisible();
  expectRequest(tableRequest, dataTableArgs);
  await expect
    .element(tableDetails.getByRole('region', { name: 'Output' }))
    .toMatchTextContent('Applied 3 operations.');

  const sqlDetails = await expandStep(
    screen.getByRole('button', { name: /Query app DB/ }),
  );
  const sqlRequest = sqlDetails.getByRole('region', { name: 'Request' });
  await expect.element(sqlRequest).toBeVisible();
  expectRequest(sqlRequest, { id: 'app-crm', sql });
  await expect
    .element(sqlDetails.getByRole('region', { name: 'Error' }))
    .toMatchTextContent('column "tag_0" does not exist');

  for (const region of [tableRequest, sqlRequest]) {
    const code = region.element().lastElementChild as HTMLElement;
    const style = getComputedStyle(code);
    expect(style.whiteSpace).toBe('pre-wrap');
    expect(style.overflowWrap).toBe('anywhere');
    expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth);
    expect(code.scrollHeight).toBeGreaterThan(code.clientHeight);
    expect(code.clientHeight).toBeLessThanOrEqual(260);
  }
  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('keeps unknown, empty, and malformed requests inspectable', async () => {
  const futureArgs = {
    mode: '',
    dry_run: false,
    retries: 0,
    previous: null,
    nested: { list: [[], {}], text: 'line 1\nline 2' },
  };
  const arrayRoot = ['wf-1', { force: true }];
  const stringRoot = '{"id":"app-1"';
  const screen = await renderMessage(
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'future',
          name: 'future_tool',
          arguments: futureArgs,
        },
        { type: 'toolCall', id: 'apps', name: 'list_apps', arguments: {} },
        { type: 'toolCall', id: 'null-root', name: 'get_app', arguments: null },
        {
          type: 'toolCall',
          id: 'array-root',
          name: 'get_workflow',
          arguments: arrayRoot,
        },
        {
          type: 'toolCall',
          id: 'string-root',
          name: 'rollback_app',
          arguments: stringRoot,
        },
        {
          type: 'toolCall',
          id: 'legacy',
          name: 'deploy_workflow',
          arguments: undefined,
        },
      ],
    },
    {
      toolResults: new Map<string, ToolResultMessage>([
        [
          'future',
          {
            role: 'toolResult',
            toolName: 'future_tool',
            content: [{ type: 'text', text: 'Future tool finished.' }],
          },
        ],
        [
          'null-root',
          {
            role: 'toolResult',
            toolName: 'get_app',
            content: [{ type: 'text', text: 'Arguments must be an object.' }],
            isError: true,
          },
        ],
      ]),
    },
  );

  const futureDetails = await expandStep(
    screen.getByRole('button', { name: /future_tool/ }),
  );
  expectRequest(
    futureDetails.getByRole('region', { name: 'Request' }),
    futureArgs,
  );
  await expect
    .element(futureDetails.getByRole('region', { name: 'Output' }))
    .toMatchTextContent('Future tool finished.');

  const expected = [
    [/List apps/, '{}'],
    [/Get app/, 'null'],
    [/Get workflow/, JSON.stringify(arrayRoot, null, 2)],
    [/Rollback app/, JSON.stringify(stringRoot)],
    [/Deploy workflow/, '(request arguments unavailable)'],
  ] as const;
  for (const [name, request] of expected) {
    const details = await expandStep(screen.getByRole('button', { name }));
    const region = details.getByRole('region', { name: 'Request' });
    await expect.element(region).toBeVisible();
    expect(sectionText(region)).toBe(request);
  }
  await expect
    .element(screen.getByRole('region', { name: 'Error' }))
    .toMatchTextContent('Arguments must be an object.');
});

test('reports unavailable and non-JSON requests without inventing one', async () => {
  const circular: Record<string, unknown> = { id: 'app-1' };
  circular.self = circular;
  // A hole would serialize as null, which the Agent never sent.
  const sparseWhere: unknown[] = [];
  sparseWhere[1] = { field: 'email', op: 'eq', value: '' };
  const screen = await render(
    <MantineProvider>
      <MessageView
        message={{
          role: 'toolResult',
          toolName: 'deploy_app',
          content: [{ type: 'text', text: 'Unpaired deploy output' }],
        }}
      />
      <StreamingToolStep
        tool={{
          id: 'bigint',
          name: 'query_app_kv',
          args: { id: 'app-1', limit: 10n },
          done: true,
          isError: true,
          output: 'limit must be an integer',
        }}
      />
      <StreamingToolStep
        tool={{
          id: 'sparse',
          name: 'query_app_data_table',
          args: { id: 'app-1', action: 'query', where: sparseWhere },
          done: true,
          isError: true,
          output: 'where[0] is required',
        }}
      />
      <StreamingToolStep
        tool={{
          id: 'circular',
          name: 'future_tool',
          args: circular,
          done: false,
          output: 'still running',
        }}
      />
    </MantineProvider>,
  );

  // Only the running step is expanded before any row is toggled.
  const runningRequest = screen.getByRole('region', { name: 'Request' });
  await expect.element(runningRequest).toBeVisible();
  expect(sectionText(runningRequest)).toBe(
    '(request arguments cannot be shown as JSON)',
  );
  await expect
    .element(screen.getByRole('region', { name: 'Output' }))
    .toMatchTextContent('still running');

  const orphanDetails = await expandStep(
    screen.getByRole('button', { name: /Deploy app/ }),
  );
  expect(
    sectionText(orphanDetails.getByRole('region', { name: 'Request' })),
  ).toBe('(request arguments unavailable)');
  await expect
    .element(orphanDetails.getByRole('region', { name: 'Output' }))
    .toMatchTextContent('Unpaired deploy output');

  const bigintDetails = await expandStep(
    screen.getByRole('button', { name: /Query app KV/ }),
  );
  expect(
    sectionText(bigintDetails.getByRole('region', { name: 'Request' })),
  ).toBe('(request arguments cannot be shown as JSON)');
  await expect
    .element(bigintDetails.getByRole('region', { name: 'Error' }))
    .toMatchTextContent('limit must be an integer');

  const sparseDetails = await expandStep(
    screen.getByRole('button', { name: /Query app Data Table/ }),
  );
  expect(
    sectionText(sparseDetails.getByRole('region', { name: 'Request' })),
  ).toBe('(request arguments cannot be shown as JSON)');
  await expect
    .element(sparseDetails.getByRole('region', { name: 'Error' }))
    .toMatchTextContent('where[0] is required');
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

test('shows successful Workflow deploys separately with state-aware actions', async () => {
  const calls = [
    deployCall('deploy-app', 'app-todo'),
    deployWorkflowCall('workflow-by-id', 'workflow-automation'),
    deployWorkflowCall('workflow-again', 'workflow-automation'),
    deployWorkflowCall('workflow-archived', 'workflow-archived'),
    deployWorkflowCall('workflow-failed', 'workflow-failed'),
    deployWorkflowCall('workflow-deleted', 'workflow-deleted'),
    deployWorkflowCall('workflow-incomplete', 'workflow-incomplete'),
  ];
  const toolResults = new Map<string, ToolResultMessage>([
    ['deploy-app', deployResult()],
    ['workflow-by-id', deployWorkflowResult()],
    ['workflow-again', deployWorkflowResult()],
    ['workflow-archived', deployWorkflowResult()],
    ['workflow-failed', deployWorkflowResult(true)],
    ['workflow-deleted', deployWorkflowResult()],
  ]);
  const screen = await renderMessage(
    { role: 'assistant', content: calls },
    {
      width: 300,
      apps: [appFixture('app-todo', 'todo', 'Todo')],
      workflows: [
        workflowFixture(
          'workflow-automation',
          'daily-automation',
          'Daily Automation',
        ),
        workflowFixture(
          'workflow-archived',
          'archived-automation',
          'Archived Automation',
          { status: 'archived' },
        ),
      ],
      toolResults,
    },
  );

  await expect
    .element(screen.getByRole('region', { name: 'Deployed app' }))
    .toBeVisible();
  const group = screen.getByRole('region', { name: 'Deployed workflows' });
  await expect.element(group.getByText('Deployed workflows · 3')).toBeVisible();
  expect(
    group.getByText('Daily Automation', { exact: true }).all(),
  ).toHaveLength(1);
  await expect.element(group.getByText('Archived Automation')).toBeVisible();
  await expect.element(group.getByText('workflow-deleted')).toBeVisible();
  await expect.element(group.getByText('Unavailable')).toBeVisible();
  const open = group.getByRole('link', { name: 'Open' });
  await expect
    .element(open)
    .toHaveAttribute('href', '/workflow/daily-automation');
  const manage = group.getByRole('link', { name: 'Manage' });
  await expect
    .element(manage)
    .toHaveAttribute('href', '/workflow/archived-automation/manage');

  await group
    .getByRole('button', { name: 'More actions for Daily Automation' })
    .click();
  const manageMenu = screen.getByRole('menuitem', {
    name: 'Manage workflow',
  });
  await expect
    .element(manageMenu)
    .toHaveAttribute('href', '/workflow/daily-automation/manage');

  const shell = screen.getByTestId('message-shell').element();
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth);
});

test('keeps historical Workflow deployment cards bound to IDs after slug reuse', async () => {
  const calls = [
    deployWorkflowCall('renamed-legacy-workflow', 'daily'),
    deployWorkflowCall('deleted-legacy-workflow', 'weekly'),
  ];
  const screen = await renderMessage(
    { role: 'assistant', content: calls },
    {
      workflows: [
        workflowFixture('new-daily-id', 'daily', 'Replacement Daily'),
        workflowFixture('new-weekly-id', 'weekly', 'Replacement Weekly'),
        workflowFixture('daily', 'renamed-daily', 'Original Daily'),
      ],
      toolResults: new Map(
        calls.map((call) => [call.id, deployWorkflowResult()]),
      ),
    },
  );

  const group = screen.getByRole('region', { name: 'Deployed workflows' });
  await expect.element(group).toBeVisible();
  expect(group.getByText('Replacement Daily').query()).toBeNull();
  expect(group.getByText('Replacement Weekly').query()).toBeNull();
  await expect.element(group.getByText('Original Daily')).toBeVisible();
  await expect
    .element(group.getByText('weekly', { exact: true }))
    .toBeVisible();
  await expect.element(group.getByText('Unavailable')).toBeVisible();
  expect(group.getByRole('link').all()).toHaveLength(1);
  await expect
    .element(group.getByRole('link', { name: 'Open' }))
    .toHaveAttribute('href', '/workflow/renamed-daily');

  await group
    .getByRole('button', { name: 'More actions for Original Daily' })
    .click();
  await expect
    .element(screen.getByRole('menuitem', { name: 'Manage workflow' }))
    .toHaveAttribute('href', '/workflow/renamed-daily/manage');
});
