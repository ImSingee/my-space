import { MantineProvider } from '@mantine/core';
import { useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AskAnswer } from '~agent/events';
import { StreamingBubble } from './streaming-bubble';
import { useAgentStream, type StreamState } from './use-agent-stream';

type TerminalCallback = (errorMessage?: string) => boolean | Promise<boolean>;

const noop = () => {};
const noopEnv = async () => false;

function errorResponse(message: string): Response {
  const envelope = JSON.stringify({
    seq: 1,
    event: { type: 'error', message },
  });
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${envelope}\n\n`));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function openResponse(signal?: AbortSignal | null): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.close(), {
          once: true,
        });
      },
    }),
    { status: 200 },
  );
}

function StreamHarness({ onTerminal }: { onTerminal: TerminalCallback }) {
  const [runId, setRunId] = useState('run-1');
  const { state, connect } = useAgentStream(noop, onTerminal);

  useEffect(() => connect(runId), [connect, runId]);

  return (
    <MantineProvider>
      <button type="button" onClick={() => setRunId('run-2')}>
        Start next run
      </button>
      <div data-testid="stream-state">
        {state.runId ?? 'none'}:{state.active ? 'active' : 'idle'}
      </div>
      {state.active || state.terminalError ? (
        <StreamingBubble state={state} onAnswer={noop} onSubmitEnv={noopEnv} />
      ) : null}
    </MantineProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('keeps partial output and announces a live terminal error', async () => {
  const state: StreamState = {
    active: false,
    runId: 'run-1',
    blocks: [{ kind: 'text', text: 'Partial reply' }],
    thinkingActive: false,
    terminalError: 'OpenAI API error (402)',
  };
  const onAnswer = vi.fn<(askId: string, answers: AskAnswer[]) => void>();

  const screen = await render(
    <MantineProvider>
      <StreamingBubble
        state={state}
        onAnswer={onAnswer}
        onSubmitEnv={noopEnv}
      />
    </MantineProvider>,
  );

  await expect.element(screen.getByText('Partial reply')).not.toBeVisible();
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('OpenAI API error (402)');
  await screen.getByRole('button', { name: 'Show work' }).click();
  await expect.element(screen.getByText('Partial reply')).toBeVisible();
});

test('keeps active thinking, prose, and tools flat', async () => {
  const state: StreamState = {
    active: true,
    runId: 'run-1',
    blocks: [
      { kind: 'thinking', text: 'Planning the implementation.' },
      { kind: 'text', text: 'I found the relevant component.' },
      {
        kind: 'tool',
        tool: {
          id: 'read-chat',
          name: 'read_file',
          args: { path: 'src/components/agent/chat.tsx' },
          done: true,
          output: 'Read chat.tsx',
        },
      },
      {
        kind: 'tool',
        tool: {
          id: 'edit-chat',
          name: 'edit_file',
          args: { path: 'src/components/agent/chat.tsx' },
          done: false,
        },
      },
    ],
    thinkingActive: false,
  };

  const screen = await render(
    <MantineProvider>
      <StreamingBubble state={state} onAnswer={noop} />
    </MantineProvider>,
  );

  expect(screen.getByRole('button', { name: 'Show work' }).query()).toBeNull();
  await expect.element(screen.getByText('Thinking')).toBeVisible();
  await expect
    .element(screen.getByText('I found the relevant component.'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('button', { name: /Read file/ }))
    .toBeVisible();
  await expect.element(screen.getByText('Edit file')).toBeVisible();
});

test('keeps the live error when transcript refresh fails', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    errorResponse('Provider unavailable'),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onTerminal = vi.fn<TerminalCallback>(async () => {
    throw new Error('Session refresh failed');
  });

  const screen = await render(<StreamHarness onTerminal={onTerminal} />);

  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('Provider unavailable');
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-1:idle');
  expect(onTerminal).toHaveBeenCalledWith('Provider unavailable');
});

test('an old terminal refresh cannot clear a newly connected run', async () => {
  let resolveRefresh: ((persisted: boolean) => void) | undefined;
  const refresh = new Promise<boolean>((resolve) => {
    resolveRefresh = resolve;
  });
  const onTerminal = vi.fn<TerminalCallback>(() => refresh);
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    String(input).includes('run-1')
      ? errorResponse('Old run failed')
      : openResponse(init?.signal),
  );
  vi.stubGlobal('fetch', fetchMock);

  const screen = await render(<StreamHarness onTerminal={onTerminal} />);
  await expect.element(screen.getByRole('alert')).toBeVisible();

  await screen.getByRole('button', { name: 'Start next run' }).click();
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-2:active');

  resolveRefresh?.(false);
  await vi.waitFor(() => expect(onTerminal).toHaveBeenCalledOnce());
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-2:active');
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
});

test('does not carry an env value into a later run with the same request id', async () => {
  const envRequest = {
    requestId: 'request-1',
    reason: 'Connect to GitHub.',
    variables: [
      {
        key: 'GITHUB_TOKEN',
        description: 'Repository access token',
        secret: true,
      },
    ],
  };
  const state = (runId: string): StreamState => ({
    active: true,
    runId,
    blocks: [],
    thinkingActive: false,
    pendingEnvRequest: envRequest,
  });
  const screen = await render(
    <MantineProvider>
      <StreamingBubble
        state={state('run-1')}
        onAnswer={noop}
        onSubmitEnv={noopEnv}
      />
    </MantineProvider>,
  );
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill('first-run-value');

  await screen.rerender(
    <MantineProvider>
      <StreamingBubble
        state={state('run-2')}
        onAnswer={noop}
        onSubmitEnv={noopEnv}
      />
    </MantineProvider>,
  );

  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toHaveValue('');
});
