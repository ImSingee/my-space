import { MantineProvider } from '@mantine/core';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AgentStreamEvent } from '~agent/events';
import { StreamingBubble } from './streaming-bubble';
import { type StreamSeed, useAgentStream } from './use-agent-stream';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
    dismiss: vi.fn<(id?: string | number) => void>(),
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

function openEventResponse(
  events: AgentStreamEvent[],
  signal?: AbortSignal | null,
): Response {
  const body = events
    .map(
      (event, index) =>
        `data: ${JSON.stringify({ seq: index + 1, event })}\n\n`,
    )
    .join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        signal?.addEventListener('abort', () => controller.close(), {
          once: true,
        });
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

function eventChannel() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
  return {
    response,
    push(seq: number, event: AgentStreamEvent) {
      controller?.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ seq, event })}\n\n`),
      );
    },
  };
}

const envRequest = {
  requestId: 'env-1',
  reason: 'Connect to GitHub.',
  variables: [
    {
      key: 'GITHUB_TOKEN',
      description: 'A token that can read the repository.',
      secret: true,
    },
  ],
};

const envSeed: StreamSeed = {
  pendingAsk: null,
  pendingEnvRequest: envRequest,
};

function StreamHarness({
  onTerminal,
}: {
  onTerminal: (errorMessage?: string) => boolean | Promise<boolean>;
}) {
  const { state, connect, answer, submitEnv, envAnnouncement } = useAgentStream(
    () => {},
    onTerminal,
  );

  useEffect(() => connect('run-1'), [connect]);

  return (
    <MantineProvider>
      <span
        data-testid="env-announcement"
        aria-live="polite"
        aria-atomic="true"
      >
        {envAnnouncement}
      </span>
      {state.active || state.terminalError ? (
        <StreamingBubble
          state={state}
          onAnswer={answer}
          onSubmitEnv={submitEnv}
        />
      ) : (
        <span>Idle</span>
      )}
    </MantineProvider>
  );
}

function SeededStreamHarness({
  switchRuns = false,
  seedControl = false,
  initialSeed = envSeed,
}: {
  switchRuns?: boolean;
  seedControl?: boolean;
  initialSeed?: StreamSeed;
}) {
  const [runId, setRunId] = useState('run-1');
  const [reconnect, setReconnect] = useState(0);
  const [seed, setSeed] = useState<StreamSeed | undefined>(initialSeed);
  const { state, connect, syncSeed, answer, submitEnv, envAnnouncement } =
    useAgentStream(
      () => {},
      async () => false,
    );

  useEffect(
    () => syncSeed(runId, runId === 'run-1' ? seed : undefined),
    [runId, seed, syncSeed],
  );
  useEffect(() => connect(runId), [connect, reconnect, runId]);

  return (
    <MantineProvider>
      <button type="button" onClick={() => setReconnect((value) => value + 1)}>
        Reconnect
      </button>
      {switchRuns ? (
        <button type="button" onClick={() => setRunId('run-2')}>
          Start next run
        </button>
      ) : null}
      {seedControl ? (
        <>
          <button
            type="button"
            onClick={() =>
              setSeed({ pendingAsk: null, pendingEnvRequest: null })
            }
          >
            Refresh cleared seed
          </button>
          <button
            type="button"
            onClick={() =>
              setSeed({
                pendingAsk: null,
                pendingEnvRequest: {
                  requestId: 'env-2',
                  reason: 'Connect to the deployment provider.',
                  variables: [
                    {
                      key: 'DEPLOY_TOKEN',
                      description: 'A token that can deploy the app.',
                      secret: true,
                    },
                  ],
                },
              })
            }
          >
            Refresh different env seed
          </button>
          <button type="button" onClick={() => setSeed(envSeed)}>
            Refresh original env seed
          </button>
        </>
      ) : null}
      <div data-testid="run-id">{state.runId ?? 'none'}</div>
      <span
        data-testid="env-announcement"
        aria-live="polite"
        aria-atomic="true"
      >
        {envAnnouncement}
      </span>
      {state.active || state.terminalError ? (
        <StreamingBubble
          state={state}
          onAnswer={answer}
          onSubmitEnv={submitEnv}
        />
      ) : null}
    </MantineProvider>
  );
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.dismiss).mockClear();
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

test('submits env values only in the POST body and clears the form on success', async () => {
  const sentinel = 'github-private-value-never-log';
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith('/events?after=0')) {
      return openEventResponse(
        [
          {
            type: 'env_request',
            requestId: 'env-1',
            reason: 'Connect to GitHub.',
            variables: [
              {
                key: 'GITHUB_TOKEN',
                description: 'A token that can read the repository.',
                secret: true,
              },
            ],
          },
        ],
        init?.signal,
      );
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<StreamHarness onTerminal={async () => false} />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill(sentinel);
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [url, init] = fetchMock.mock.calls[1];
  expect(String(url)).toBe('/api/agent/runs/run-1/env');
  expect(String(url)).not.toContain(sentinel);
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({
    requestId: 'env-1',
    entries: [{ key: 'GITHUB_TOKEN', value: sentinel, secret: true }],
  });
  await expect.element(input).not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId('env-announcement'))
    .toHaveTextContent('Environment variables saved.');
  await expect
    .element(screen.getByTestId('env-announcement'))
    .not.toHaveTextContent(sentinel);
  expect(toast.error).not.toHaveBeenCalled();
});

test('retains env values and shows a fixed error when submission fails', async () => {
  const sentinel = 'keep-after-failure';
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith('/events?after=0')) {
      return openEventResponse(
        [
          {
            type: 'env_request',
            requestId: 'env-2',
            reason: 'Connect to GitHub.',
            variables: [
              {
                key: 'GITHUB_TOKEN',
                description: 'A token that can read the repository.',
                secret: true,
              },
            ],
          },
        ],
        init?.signal,
      );
    }
    return new Response(`Rejected ${sentinel}`, { status: 503 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<StreamHarness onTerminal={async () => false} />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill(sentinel);
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();

  await expect.element(input).toHaveValue(sentinel);
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'Could not confirm the environment variables were saved. Try again.',
      { id: 'agent-env-save-failed:run-1:env-2' },
    ),
  );
  expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(
    sentinel,
  );
  await expect
    .element(screen.getByTestId('env-announcement'))
    .not.toHaveTextContent(sentinel);
});

test('hydrates a pending env request and preserves its input on same-run reconnect', async () => {
  const first = eventChannel();
  const second = eventChannel();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(first.response)
    .mockResolvedValueOnce(second.response);
  vi.stubGlobal('fetch', fetchMock);

  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await expect.element(input).toBeVisible();
  await input.fill('preserve-across-reconnect');
  first.push(7, { type: 'env_request', ...envRequest });
  first.push(8, { type: 'text', delta: 'Replay checkpoint' });
  await expect.element(screen.getByText('Replay checkpoint')).toBeVisible();

  await screen.getByRole('button', { name: 'Reconnect' }).click();

  await expect.element(input).toHaveValue('preserve-across-reconnect');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    '/api/agent/runs/run-1/events?after=8',
  );
});

test('preserves a live env request and its input when same-run reconnect has a stale null seed', async () => {
  const first = eventChannel();
  const second = eventChannel();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(first.response)
    .mockResolvedValueOnce(second.response);
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(
    <SeededStreamHarness
      initialSeed={{ pendingAsk: null, pendingEnvRequest: null }}
    />,
  );

  first.push(1, { type: 'env_request', ...envRequest });
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await expect.element(input).toBeVisible();
  await input.fill('keep-across-stale-null');

  await screen.getByRole('button', { name: 'Reconnect' }).click();

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await expect.element(input).toHaveValue('keep-across-stale-null');
  expect(String(fetchMock.mock.calls[1][0])).toBe(
    '/api/agent/runs/run-1/events?after=1',
  );
});

test('does not let historical prompts unmount a hydrated env form', async () => {
  const channel = eventChannel();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => channel.response),
  );
  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill('keep-during-replay');

  channel.push(1, {
    type: 'ask',
    askId: 'old-ask',
    questions: [
      {
        id: 'old-question',
        prompt: 'Old question',
        options: [{ id: 'yes', label: 'Yes' }],
        allowMultiple: false,
      },
    ],
  });
  channel.push(2, { type: 'text', delta: 'Replay advanced' });
  await expect.element(screen.getByText('Replay advanced')).toBeVisible();
  await expect.element(input).toHaveValue('keep-during-replay');
  await expect
    .element(screen.getByText('Old question'))
    .not.toBeInTheDocument();

  channel.push(3, { type: 'env_request', ...envRequest });
  await expect.element(input).toHaveValue('keep-during-replay');
});

test('ignores events from an aborted connection generation', async () => {
  const first = eventChannel();
  const second = eventChannel();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(first.response)
    .mockResolvedValueOnce(second.response);
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness />);
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toBeVisible();

  await screen.getByRole('button', { name: 'Reconnect' }).click();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  first.push(1, { type: 'text', delta: 'Stale connection output' });
  second.push(1, { type: 'text', delta: 'Current connection output' });

  await expect
    .element(screen.getByText('Current connection output'))
    .toBeVisible();
  await expect
    .element(screen.getByText('Stale connection output'))
    .not.toBeInTheDocument();
});

test('aborts an in-flight env POST when a different run takes over', async () => {
  const firstStream = eventChannel();
  const secondStream = eventChannel();
  let postSignal: AbortSignal | null | undefined;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('run-1/events')) return firstStream.response;
    if (url.includes('run-2/events')) return secondStream.response;
    if (url.includes('/env')) {
      postSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness switchRuns />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill('abort-with-old-run');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();
  await vi.waitFor(() => expect(postSignal).toBeDefined());

  await screen.getByRole('button', { name: 'Start next run' }).click();

  await vi.waitFor(() => expect(postSignal?.aborted).toBe(true));
  firstStream.push(99, { type: 'text', delta: 'Output from old run' });
  secondStream.push(1, { type: 'text', delta: 'Output from next run' });
  await expect.element(screen.getByTestId('run-id')).toHaveTextContent('run-2');
  await expect.element(screen.getByText('Output from next run')).toBeVisible();
  await expect
    .element(screen.getByText('Output from old run'))
    .not.toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
});

test('aborts an old env POST when an authoritative seed selects a different request', async () => {
  const firstStream = eventChannel();
  const secondStream = eventChannel();
  let eventCall = 0;
  let firstPostSignal: AbortSignal | null | undefined;
  const postBodies: unknown[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/events')) {
      eventCall += 1;
      return eventCall === 1 ? firstStream.response : secondStream.response;
    }
    if (url.includes('/env')) {
      postBodies.push(JSON.parse(String(init?.body)));
      if (postBodies.length === 1) {
        firstPostSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness seedControl />);
  await screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/).fill('obsolete-value');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();
  await vi.waitFor(() => expect(firstPostSignal).toBeDefined());

  await screen
    .getByRole('button', { name: 'Refresh different env seed' })
    .click();

  await vi.waitFor(() => expect(firstPostSignal?.aborted).toBe(true));
  const nextInput = screen.getByLabelText(/^DEPLOY_TOKEN(?: \*)?$/);
  await expect.element(nextInput).toBeEnabled();
  await nextInput.fill('current-value');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();

  await expect.element(nextInput).not.toBeInTheDocument();
  expect(postBodies).toHaveLength(2);
  expect(postBodies[1]).toEqual({
    requestId: 'env-2',
    entries: [{ key: 'DEPLOY_TOKEN', value: 'current-value', secret: true }],
  });
  expect(toast.error).not.toHaveBeenCalled();
});

test('accepts a delayed env_stored event after the POST response fails', async () => {
  const channel = eventChannel();
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (String(input).includes('/events')) return channel.response;
    return new Response('Confirmation was delayed', { status: 504 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  channel.push(1, { type: 'env_request', ...envRequest });
  channel.push(2, { type: 'text', delta: 'Ready for delayed confirmation' });
  await expect
    .element(screen.getByText('Ready for delayed confirmation'))
    .toBeVisible();
  await input.fill('stored-despite-response');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  channel.push(3, {
    type: 'env_stored',
    requestId: envRequest.requestId,
    variables: [{ key: 'GITHUB_TOKEN', secret: true }],
  });

  await expect.element(input).not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId('env-announcement'))
    .toHaveTextContent('Environment variables saved.');
  expect(toast.error).not.toHaveBeenCalled();
});

test('dismisses a save-error toast when a later stored event confirms success', async () => {
  const channel = eventChannel();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/events')
        ? channel.response
        : new Response('Confirmation was delayed', { status: 504 }),
    ),
  );
  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  channel.push(1, { type: 'env_request', ...envRequest });
  channel.push(2, { type: 'text', delta: 'Ready for late confirmation' });
  await expect
    .element(screen.getByText('Ready for late confirmation'))
    .toBeVisible();
  await input.fill('late-confirmation');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'Could not confirm the environment variables were saved. Try again.',
      { id: 'agent-env-save-failed:run-1:env-1' },
    ),
  );

  channel.push(3, {
    type: 'env_stored',
    requestId: envRequest.requestId,
    variables: [{ key: 'GITHUB_TOKEN', secret: true }],
  });

  await expect.element(input).not.toBeInTheDocument();
  expect(toast.dismiss).toHaveBeenCalledWith(
    'agent-env-save-failed:run-1:env-1',
  );
});

test('does not restore an HTTP-confirmed request from a stale session seed', async () => {
  const first = eventChannel();
  const second = eventChannel();
  let eventCall = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes('/events')) {
      eventCall += 1;
      return eventCall === 1 ? first.response : second.response;
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill('already-stored');
  await screen
    .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
    .click();
  await expect.element(input).not.toBeInTheDocument();

  await screen.getByRole('button', { name: 'Reconnect' }).click();

  await vi.waitFor(() => expect(eventCall).toBe(2));
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();
});

test('keeps a stored-request tombstone across reconnects until the seed clears', async () => {
  const first = eventChannel();
  const second = eventChannel();
  let eventCall = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      eventCall += 1;
      return [first.response, second.response][eventCall - 1];
    }),
  );
  const screen = await render(<SeededStreamHarness seedControl />);
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toBeVisible();
  first.push(1, { type: 'env_request', ...envRequest });
  first.push(2, { type: 'text', delta: 'Tombstone stream ready' });
  await expect
    .element(screen.getByText('Tombstone stream ready'))
    .toBeVisible();
  first.push(3, {
    type: 'env_stored',
    requestId: envRequest.requestId,
    variables: [{ key: 'GITHUB_TOKEN', secret: true }],
  });
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();

  await screen.getByRole('button', { name: 'Reconnect' }).click();
  await vi.waitFor(() => expect(eventCall).toBe(2));
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();

  await screen.getByRole('button', { name: 'Refresh cleared seed' }).click();
  expect(eventCall).toBe(2);
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();

  second.push(4, { type: 'env_request', ...envRequest });
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toBeVisible();
});

test('keeps sequential confirmations so an older stale seed cannot return', async () => {
  const first = eventChannel();
  let eventCall = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      eventCall += 1;
      return first.response;
    }),
  );
  const screen = await render(<SeededStreamHarness seedControl />);
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .toBeVisible();
  first.push(1, { type: 'env_request', ...envRequest });
  first.push(2, {
    type: 'env_stored',
    requestId: envRequest.requestId,
    variables: [{ key: 'GITHUB_TOKEN', secret: true }],
  });
  first.push(3, {
    type: 'env_request',
    requestId: 'env-2',
    reason: 'Connect to the deployment provider.',
    variables: [
      {
        key: 'DEPLOY_TOKEN',
        description: 'A token that can deploy the app.',
        secret: true,
      },
    ],
  });
  const secondInput = screen.getByLabelText(/^DEPLOY_TOKEN(?: \*)?$/);
  await expect.element(secondInput).toBeVisible();
  await screen
    .getByRole('button', { name: 'Refresh different env seed' })
    .click();
  expect(eventCall).toBe(1);
  first.push(4, {
    type: 'env_stored',
    requestId: 'env-2',
    variables: [{ key: 'DEPLOY_TOKEN', secret: true }],
  });
  await expect.element(secondInput).not.toBeInTheDocument();

  await screen
    .getByRole('button', { name: 'Refresh original env seed' })
    .click();

  expect(eventCall).toBe(1);
  await expect
    .element(screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByLabelText(/^DEPLOY_TOKEN(?: \*)?$/))
    .not.toBeInTheDocument();
});

test('times out and aborts a stalled env POST without exposing its value', async () => {
  const channel = eventChannel();
  let postSignal: AbortSignal | null | undefined;
  const sentinel = 'timeout-private-value-never-toast';
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).includes('/events')) return channel.response;
    postSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const screen = await render(<SeededStreamHarness />);
  const input = screen.getByLabelText(/^GITHUB_TOKEN(?: \*)?$/);
  await input.fill(sentinel);

  vi.useFakeTimers();
  try {
    await screen
      .getByRole('button', { name: 'Save 1 variable, share 0 with AI' })
      .click();
    expect(postSignal).toBeDefined();
    await vi.advanceTimersByTimeAsync(16000);

    expect(postSignal?.aborted).toBe(true);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not confirm the environment variables were saved. Try again.',
      { id: 'agent-env-save-failed:run-1:env-1' },
    );
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain(
      sentinel,
    );
    await expect
      .element(screen.getByTestId('env-announcement'))
      .not.toHaveTextContent(sentinel);
  } finally {
    vi.useRealTimers();
  }
});
