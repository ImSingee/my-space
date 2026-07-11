import { MantineProvider } from '@mantine/core';
import { useEffect, useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AskAnswer } from '~agent/events';
import { StreamingBubble } from './streaming-bubble';
import { useAgentStream, type StreamState } from './use-agent-stream';

type TerminalCallback = (errorMessage?: string) => boolean | Promise<boolean>;

const noop = () => {};

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
        <StreamingBubble state={state} onAnswer={noop} />
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
      <StreamingBubble state={state} onAnswer={onAnswer} />
    </MantineProvider>,
  );

  await expect.element(screen.getByText('Partial reply')).toBeVisible();
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('OpenAI API error (402)');
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
