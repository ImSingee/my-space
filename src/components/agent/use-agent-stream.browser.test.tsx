import { MantineProvider } from '@mantine/core';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AgentStreamEvent } from '~agent/events';
import { StreamingBubble } from './streaming-bubble';
import { useAgentStream } from './use-agent-stream';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
  },
}));

function eventResponse(events: AgentStreamEvent[]): Response {
  const body = events
    .map(
      (event, index) =>
        `data: ${JSON.stringify({ seq: index + 1, event })}\n\n`,
    )
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function StreamHarness({
  onTerminal,
}: {
  onTerminal: (errorMessage?: string) => boolean | Promise<boolean>;
}) {
  const { state, connect, answer } = useAgentStream(() => {}, onTerminal);

  useEffect(() => connect('run-1'), [connect]);

  return (
    <MantineProvider>
      {state.active || state.terminalError ? (
        <StreamingBubble state={state} onAnswer={answer} />
      ) : (
        <span>Idle</span>
      )}
    </MantineProvider>
  );
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      eventResponse([
        { type: 'assistant_start' },
        { type: 'text', delta: 'Partial reply' },
        { type: 'error', message: 'OpenAI API error (402)' },
      ]),
    ),
  );
});

test('keeps the live error until the persisted transcript is ready', async () => {
  let resolveTerminal!: (persisted: boolean) => void;
  const terminal = new Promise<boolean>((resolve) => {
    resolveTerminal = resolve;
  });
  const onTerminal = vi.fn<(errorMessage?: string) => Promise<boolean>>(
    () => terminal,
  );
  const screen = await render(<StreamHarness onTerminal={onTerminal} />);

  await expect.element(screen.getByText('Partial reply')).toBeVisible();
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('OpenAI API error (402)');
  expect(onTerminal).toHaveBeenCalledWith('OpenAI API error (402)');

  resolveTerminal(true);

  await expect.element(screen.getByText('Idle')).toBeVisible();
  expect(toast.error).not.toHaveBeenCalled();
});

test('falls back to a toast when the refreshed transcript has no error', async () => {
  const screen = await render(<StreamHarness onTerminal={async () => false} />);

  await expect.element(screen.getByText('Idle')).toBeVisible();
  expect(toast.error).toHaveBeenCalledWith('OpenAI API error (402)');
});

test('keeps the inline error when the transcript refetch fails', async () => {
  const screen = await render(
    <StreamHarness
      onTerminal={async () => {
        throw new Error('Session refetch failed');
      }}
    />,
  );

  await expect.element(screen.getByText('Partial reply')).toBeVisible();
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent('OpenAI API error (402)');
  expect(toast.error).not.toHaveBeenCalled();
});
