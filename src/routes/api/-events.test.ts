import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestPlatformEvent = {
  type: 'app.deployment.activated';
  appId: string;
  deploymentRevision: string;
};

const mocks = vi.hoisted(() => ({
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  unsubscribe: vi.fn<() => void>(),
  subscribePlatformEvents:
    vi.fn<(subscriber: (event: TestPlatformEvent) => void) => () => void>(),
}));

vi.mock('~auth/server', () => ({
  auth: { api: { getSession: mocks.getSession } },
}));
vi.mock('~server/platform-events', () => ({
  subscribePlatformEvents: mocks.subscribePlatformEvents,
}));

import { handle } from './events';

const decoder = new TextDecoder();

describe('Platform events API stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.subscribePlatformEvents.mockReturnValue(mocks.unsubscribe);
  });

  it('rejects unauthenticated requests without subscribing', async () => {
    mocks.getSession.mockResolvedValue(null);

    const response = await handle({
      request: new Request('https://hatch.test/api/events'),
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('Unauthorized');
    expect(mocks.subscribePlatformEvents).not.toHaveBeenCalled();
  });

  it('sends resync first and then named Platform events', async () => {
    const response = await handle({
      request: new Request('https://hatch.test/api/events'),
    });
    const reader = response.body!.getReader();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-transform',
    );
    const resync = await reader.read();
    expect(resync.done).toBe(false);
    expect(decoder.decode(resync.value)).toBe('event: resync\ndata: {}\n\n');

    const subscriber = mocks.subscribePlatformEvents.mock.calls[0]?.[0];
    expect(subscriber).toBeDefined();
    const event: TestPlatformEvent = {
      type: 'app.deployment.activated',
      appId: 'app-1',
      deploymentRevision: 'revision-2',
    };
    subscriber!(event);

    const platform = await reader.read();
    expect(decoder.decode(platform.value)).toBe(
      `event: platform\ndata: ${JSON.stringify(event)}\n\n`,
    );
    await reader.cancel();
  });

  it('sends a comment heartbeat every 20 seconds', async () => {
    vi.useFakeTimers();
    try {
      const response = await handle({
        request: new Request('https://hatch.test/api/events'),
      });
      const reader = response.body!.getReader();
      await reader.read();

      await vi.advanceTimersByTimeAsync(20_000);

      const heartbeat = await reader.read();
      expect(decoder.decode(heartbeat.value)).toBe(': keep-alive\n\n');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes when the response body is cancelled', async () => {
    const response = await handle({
      request: new Request('https://hatch.test/api/events'),
    });

    await response.body!.cancel();

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes when the request is aborted', async () => {
    const abort = new AbortController();
    const response = await handle({
      request: new Request('https://hatch.test/api/events', {
        signal: abort.signal,
      }),
    });
    const reader = response.body!.getReader();
    await reader.read();

    abort.abort();

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});
