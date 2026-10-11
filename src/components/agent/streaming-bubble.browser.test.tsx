import { MantineProvider } from '@mantine/core';
import { useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AgentStreamEvent, AskAnswer } from '~agent/events';
import { StreamingBubble } from './streaming-bubble';
import {
  type StreamOutcome,
  type StreamState,
  useAgentStream,
} from './use-agent-stream';
import { defaultWorkExpanded } from './work-process';

type SettledCallback = (runId: string, outcome: StreamOutcome) => void;

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

function mockLiveStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let seq = 0;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const close = () => {
    if (closed) return;
    closed = true;
    controller.close();
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_input, init) => {
      init?.signal?.addEventListener('abort', close, { once: true });
      return new Response(body, { status: 200 });
    }),
  );
  return (event: AgentStreamEvent) => {
    seq += 1;
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ seq, event })}\n\n`),
    );
    if (event.type === 'done') close();
  };
}

function StreamHarness({ onSettled = noop }: { onSettled?: SettledCallback }) {
  const [runId, setRunId] = useState('run-1');
  const { state, connect, release } = useAgentStream({ onSettled });
  const phase = state.outcome ?? 'running';

  useEffect(() => connect(runId), [connect, runId]);

  return (
    <MantineProvider>
      <button type="button" onClick={() => setRunId('run-2')}>
        Start next run
      </button>
      <button type="button" onClick={() => release('run-1')}>
        Release first run
      </button>
      <div data-testid="stream-state">
        {state.runId ?? 'none'}:
        {state.active ? 'active' : (state.outcome ?? 'idle')}
      </div>
      {state.active || state.outcome ? (
        <StreamingBubble
          state={state}
          onAnswer={noop}
          onSubmitEnv={noopEnv}
          work={{
            phase,
            timing: null,
            expanded: defaultWorkExpanded(phase),
            onToggle: noop,
          }}
        />
      ) : null}
    </MantineProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('restores the waiting indicator between tools after earlier prose', async () => {
  const emit = mockLiveStream();
  const screen = await render(<StreamHarness />);
  const thinking = screen.getByText('Thinking…', { exact: true });
  await expect.element(thinking).toBeVisible();

  emit({ type: 'text', delta: 'I will inspect the files.' });
  await expect
    .element(screen.getByText('I will inspect the files.'))
    .toBeVisible();
  await expect.element(thinking).not.toBeInTheDocument();

  for (const id of ['tool-1', 'tool-2']) {
    emit({
      type: 'tool_start',
      id,
      name: 'read_file',
      label: `Inspect ${id}`,
      args: {},
    });
    await expect.element(screen.getByText(`Inspect ${id}`)).toBeVisible();
    await expect.element(thinking).not.toBeInTheDocument();
    emit({ type: 'tool_end', id, name: 'read_file', isError: false });
    await expect.element(thinking).toBeVisible();
    await expect
      .element(screen.getByText('I will inspect the files.'))
      .toBeVisible();
  }

  emit({ type: 'text', delta: 'The files are ready.' });
  await expect.element(screen.getByText('The files are ready.')).toBeVisible();
  await expect.element(thinking).not.toBeInTheDocument();
  emit({ type: 'assistant_start' });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'done' });
  await expect.element(thinking).not.toBeInTheDocument();
  // The finished turn stays on screen until it is released: its process folds
  // away and the final answer remains visible.
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-1:completed');
  await expect.element(screen.getByText('The files are ready.')).toBeVisible();
  await expect
    .element(screen.getByText('I will inspect the files.'))
    .not.toBeVisible();
  await screen.getByRole('button', { name: 'Release first run' }).click();
  await expect
    .element(screen.getByText('The files are ready.'))
    .not.toBeInTheDocument();
});

test('waits for every concurrent tool and stops indicating work on failure', async () => {
  const emit = mockLiveStream();
  const screen = await render(<StreamHarness />);
  const thinking = screen.getByText('Thinking…', { exact: true });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'text', delta: 'Checking both files.' });
  await expect.element(screen.getByText('Checking both files.')).toBeVisible();
  emit({
    type: 'tool_start',
    id: 'tool-1',
    name: 'read_file',
    label: 'Read first file',
    args: {},
  });
  emit({ type: 'tool_start', id: 'tool-2', name: 'read_file', args: {} });
  emit({
    type: 'tool_end',
    id: 'tool-1',
    name: 'read_file',
    isError: false,
    output: 'First file contents',
  });
  await expect
    .element(screen.getByRole('button', { name: 'Read first file' }))
    .toBeVisible();
  await expect.element(thinking).not.toBeInTheDocument();
  emit({ type: 'tool_end', id: 'tool-2', name: 'read_file', isError: false });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'error', message: 'Provider unavailable' });
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('Provider unavailable');
  await expect.element(thinking).not.toBeInTheDocument();
});

test('shows one reasoning indicator and pauses it for human input', async () => {
  const emit = mockLiveStream();
  const screen = await render(<StreamHarness />);
  const thinking = screen.getByText('Thinking…', { exact: true });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'text', delta: 'Reviewing the request.' });
  await expect
    .element(screen.getByText('Reviewing the request.'))
    .toBeVisible();
  emit({ type: 'thinking', delta: '\n\n' });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'thinking', delta: 'Consider the available options.' });
  await expect
    .element(screen.getByText('Consider the available options.'))
    .toBeVisible();
  await expect.element(thinking).toBeVisible();
  emit({
    type: 'ask',
    askId: 'ask-1',
    questions: [
      {
        id: 'choice',
        prompt: 'Which option?',
        options: [{ id: 'first', label: 'First option' }],
        allowMultiple: false,
      },
    ],
  });
  await expect.element(screen.getByText('Which option?')).toBeVisible();
  await expect.element(thinking).not.toBeInTheDocument();
  emit({ type: 'ask_answered', askId: 'ask-1' });
  await expect.element(thinking).toBeVisible();
  emit({
    type: 'env_request',
    requestId: 'env-1',
    reason: 'Connect to GitHub.',
    variables: [
      {
        key: 'GITHUB_TOKEN',
        description: 'Repository access token',
        secret: true,
      },
    ],
  });
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toBeVisible();
  await expect.element(thinking).not.toBeInTheDocument();
  emit({
    type: 'env_stored',
    requestId: 'env-1',
    variables: [{ key: 'GITHUB_TOKEN', secret: true }],
  });
  await expect.element(thinking).toBeVisible();
  emit({ type: 'cancelled' });
  await expect.element(thinking).not.toBeInTheDocument();
});

test('keeps partial output and announces a live terminal error', async () => {
  const state: StreamState = {
    active: false,
    runId: 'run-1',
    blocks: [{ kind: 'text', text: 'Partial reply' }],
    thinkingActive: false,
    textActive: false,
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

  await expect.element(screen.getByText('Partial reply')).toBeVisible();
  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('OpenAI API error (402)');
});

test('keeps a settled failure until the caller releases it', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    errorResponse('Provider unavailable'),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onSettled = vi.fn<SettledCallback>();

  const screen = await render(<StreamHarness onSettled={onSettled} />);

  await expect
    .element(screen.getByRole('alert'))
    .toMatchTextContent('Provider unavailable');
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-1:failed');
  expect(onSettled).toHaveBeenCalledExactlyOnceWith('run-1', 'failed');

  await screen.getByRole('button', { name: 'Release first run' }).click();
  await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
});

test('a late release for an old run cannot clear a newly connected run', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) =>
    String(input).includes('run-1')
      ? errorResponse('Old run failed')
      : openResponse(init?.signal),
  );
  vi.stubGlobal('fetch', fetchMock);

  const screen = await render(<StreamHarness />);
  await expect.element(screen.getByRole('alert')).toBeVisible();

  await screen.getByRole('button', { name: 'Start next run' }).click();
  await expect
    .element(screen.getByTestId('stream-state'))
    .toHaveTextContent('run-2:active');

  await screen.getByRole('button', { name: 'Release first run' }).click();
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
    textActive: false,
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
