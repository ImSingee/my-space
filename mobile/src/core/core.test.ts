import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HatchApiClient } from './client';
import type { FetchLike } from './client';
import { DeviceLogin, type DeviceCode } from './device-login';
import {
  MobileError,
  apiPath,
  canonicalizeInstanceUrl,
  validateHandoff,
  validateVerificationUrl,
  webViewHandoffSource,
} from './security';
import {
  initialStreamState,
  reduceStreamEvent,
  SseParser,
  streamRunEvents,
} from './stream';
import { InstanceVault } from './vault';
import type { RunStreamEvent } from './types';

const origin = 'https://hatch.example.test';
function setup(
  fetcher: FetchLike = vi.fn<FetchLike>(),
  onUnauthorized = vi.fn<(origin: string) => void>(),
) {
  const values = new Map<string, string>();
  const storage = {
    get: vi.fn<(key: string) => Promise<string | null>>(
      async (key: string) => values.get(key) ?? null,
    ),
    set: vi.fn<(key: string, value: string) => Promise<void>>(
      async (key: string, value: string) => {
        values.set(key, value);
      },
    ),
    remove: vi.fn<(key: string) => Promise<void>>(async (key: string) => {
      values.delete(key);
    }),
  };
  const vault = new InstanceVault(storage, async (value) =>
    createHash('sha256').update(value).digest('hex'),
  );
  const client = new HatchApiClient({
    origin,
    vault,
    fetch: fetcher,
    onUnauthorized,
  });
  return { client, vault, values, storage, onUnauthorized };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function event(seq: number, value: RunStreamEvent['event']): string {
  return `data: ${JSON.stringify({ seq, event: value })}\n\n`;
}
function stream(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function grant(extra: Record<string, unknown> = {}) {
  return {
    device_code: 'fixture-device-secret',
    user_code: 'ABCD-1234',
    verification_uri_complete: `${origin}/cli/authorize?user_code=ABCD-1234`,
    expires_in: 600,
    interval: 1,
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('instance and credential boundaries', () => {
  it('uses generated Connect clients and projects shared App/Agent messages for the UI', async () => {
    const app = {
      id: 'app-1',
      slug: 'example',
      name: 'Example',
      description: null,
      status: 'deployed',
      createdAt: '2026-10-16T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    };
    const session = {
      id: 'session-1',
      title: 'Example',
      messages: [],
      activeRun: null,
      runs: [],
      appIds: [],
      providerId: null,
      modelId: null,
      updatedAt: app.updatedAt,
      serverTime: app.updatedAt,
    };
    const handoff = {
      ticket: 'a'.repeat(43),
      url: `${origin}/api/auth/handoffs/consume`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      targetPath: '/app/example/embed/',
    };
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json({ resources: [app] }))
      .mockResolvedValueOnce(json({ resource: app }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ id: session.id }))
      .mockResolvedValueOnce(json({ session }))
      .mockResolvedValueOnce(json(handoff));
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    expect(await client.apps()).toEqual([app]);
    expect(await client.app(app.id)).toEqual(app);
    expect(await client.sessions(app.id)).toEqual([]);
    expect(await client.createSession()).toEqual({ id: session.id });
    expect(await client.session(session.id)).toEqual(session);
    expect(await client.handoff(app.id)).toEqual(handoff);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/api/rpc/hatch.platform.v1.AppService/ListApps`,
      `${origin}/api/rpc/hatch.platform.v1.AppService/GetApp`,
      `${origin}/api/rpc/hatch.platform.v1.AgentService/ListSessions`,
      `${origin}/api/rpc/hatch.platform.v1.AgentService/CreateSession`,
      `${origin}/api/rpc/hatch.platform.v1.AgentService/GetSession`,
      `${origin}/api/rpc/hatch.platform.v1.AppService/CreateAppHandoff`,
    ]);
    expect(
      JSON.parse(
        new TextDecoder().decode(fetcher.mock.calls[5][1].body as Uint8Array),
      ),
    ).toEqual({ id: 'app-1' });
    expect(
      JSON.parse(
        new TextDecoder().decode(fetcher.mock.calls[2][1].body as Uint8Array),
      ),
    ).toEqual({ appId: 'app-1' });
    for (const [, options] of fetcher.mock.calls) {
      expect(options.method).toBe('POST');
      expect(new Headers(options.headers).get('connect-protocol-version')).toBe(
        '1',
      );
    }
  });
  it('canonicalizes HTTPS origins while rejecting normalized path tricks and credential-bearing URLs', () => {
    expect(canonicalizeInstanceUrl('https://HATCH.example.test:443/')).toBe(
      origin,
    );
    for (const input of [
      'http://hatch.example.test',
      'http://localhost:3000',
      `${origin}/app`,
      `${origin}/./`,
      `${origin}/a/..`,
      `${origin}/%2e/`,
      `${origin}?token=secret`,
      `${origin}#token`,
      `${origin}?`,
      `${origin}#`,
      'https://user:secret@hatch.example.test',
      'https://@hatch.example.test',
      'https://hatch.example.test\\@evil.test',
      'https://hatch.example.test\n',
      ' https://hatch.example.test',
      '//hatch.example.test',
    ])
      expect(() => canonicalizeInstanceUrl(input)).toThrow(MobileError);
    expect(
      canonicalizeInstanceUrl('http://127.0.0.1:3000/', {
        allowDevelopmentLoopback: true,
      }),
    ).toBe('http://127.0.0.1:3000');
    expect(() =>
      canonicalizeInstanceUrl('http://192.168.1.2:3000', {
        allowDevelopmentLoopback: true,
      }),
    ).toThrow(MobileError);
  });
  it('allows only the matching same-origin device verification page and code', () => {
    const valid = `${origin}/cli/authorize?user_code=ABCD-1234`;
    expect(validateVerificationUrl(origin, valid, 'ABCD-1234')).toBe(valid);
    for (const value of [
      'https://other.test/cli/authorize?user_code=ABCD-1234',
      `${origin}/app?user_code=ABCD-1234`,
      `${valid}&redirect=https://other.test`,
      `${valid}#fragment`,
      `${valid}&user_code=OTHER`,
      `${origin}/cli/authorize?user_code=OTHER`,
    ])
      expect(() => validateVerificationUrl(origin, value, 'ABCD-1234')).toThrow(
        MobileError,
      );
  });
  it('hands off through an origin-checked form POST without URL or cookie credentials', () => {
    const handoff = {
      ticket: 'a'.repeat(32),
      url: `${origin}/api/auth/handoffs/consume`,
      targetPath: '/app/example-app/embed/',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const source = webViewHandoffSource(origin, handoff);
    expect(source.method).toBe('POST');
    expect(source.uri).toBe(handoff.url);
    expect(new URL(source.uri).search).toBe('');
    expect([...new URLSearchParams(source.body)]).toEqual([
      ['ticket', handoff.ticket],
    ]);
    expect(source.headers).toMatchObject({
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(source.headers).not.toHaveProperty('Authorization');
    expect(source.headers).not.toHaveProperty('Cookie');
  });

  it('rejects cross-origin, encoded traversal, and invalid handoff destinations', () => {
    for (const path of [
      '//evil.test/api',
      '/api/../login',
      '/api/%2e%2e/login',
      '/api/x%2fy',
      '/api/x#token',
      '/api/\\evil.test',
    ]) {
      expect(() => apiPath(origin, path)).toThrow(MobileError);
    }
    const valid = {
      url: `${origin}/api/auth/handoffs/consume`,
      ticket: 'a'.repeat(32),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      targetPath: '/app/demo/embed/',
    };
    expect(() => validateHandoff(origin, valid)).not.toThrow();
    expect(() =>
      validateHandoff(origin, {
        ...valid,
        url: `${origin}/api/v1/auth/handoffs/consume`,
      }),
    ).toThrow(MobileError);
    expect(() =>
      validateHandoff(origin, {
        ...valid,
        url: 'https://evil.test/api/auth/handoffs/consume',
      }),
    ).toThrow(MobileError);
    expect(() =>
      validateHandoff(origin, { ...valid, targetPath: '/app/demo/../admin' }),
    ).toThrow(MobileError);
    expect(() =>
      validateHandoff(origin, { ...valid, expiresAt: '2000-01-01T00:00:00Z' }),
    ).toThrow(MobileError);
  });
  it('keeps tokens isolated by SHA256 canonical origin and never persists a raw origin key', async () => {
    const { vault, values } = setup();
    await vault.set(origin, 'fixture-token-one');
    await vault.set('https://other.example.test', 'fixture-token-two');
    expect(await vault.get('https://HATCH.example.test:443/')).toBe(
      'fixture-token-one',
    );
    await vault.remove(origin);
    expect(await vault.get(origin)).toBeNull();
    expect(await vault.get('https://other.example.test')).toBe(
      'fixture-token-two',
    );
    expect([...values.keys()]).toEqual([
      expect.stringMatching(/^hatch\.mobile\.token\.v1\.[a-f0-9]{64}$/),
    ]);
  });
  it('clears only the rejected instance token on 401 and ignores late 401s for rotated tokens', async () => {
    let answer: (response: Response) => void = () => {};
    const fetcher = vi.fn<FetchLike>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { client, vault, onUnauthorized } = setup(fetcher);
    await vault.set(origin, 'old-token');
    await vault.set('https://other.example.test', 'other-token');
    const request = client.apps();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vault.set(origin, 'new-token');
    answer(json({}, 401));
    await expect(request).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await vault.get(origin)).toBe('new-token');
    expect(onUnauthorized).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(json({}, 401));
    await expect(client.apps()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await vault.get(origin)).toBeNull();
    expect(await vault.get('https://other.example.test')).toBe('other-token');
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith(origin);
  });
  it('never follows credentialed redirects or sends cookies, and validates paths before transport', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(json({}, 302));
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    await expect(client.apps()).rejects.toMatchObject({
      code: 'redirect_blocked',
    });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`${origin}/api/rpc/hatch.platform.v1.AppService/ListApps`);
    expect(url).not.toContain('fixture-token');
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
    expect(options.cache).toBe('no-store');
    expect(new Headers(options.headers).get('cache-control')).toBe('no-store');
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer fixture-token',
    );
    await expect(client.request('https://evil.test/api')).rejects.toMatchObject(
      { code: 'invalid_path' },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('disables HTTP caching for device tokens, authenticated data, and event streams', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json({ access_token: 'fixture-token' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(stream([event(1, { type: 'done' })]));
    const { client, vault } = setup(fetcher);
    const signal = new AbortController().signal;
    await client.deviceRequest('/api/auth/device/token', {}, signal, 1000);
    await vault.set(origin, 'fixture-token');
    await client.apps();
    await client.streamRun('run-1', { signal, onEvent: () => {} });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, options] of fetcher.mock.calls) {
      expect(options.cache).toBe('no-store');
      expect(new Headers(options.headers).get('cache-control')).toBe(
        'no-store',
      );
      expect(options.credentials).toBe('omit');
    }
    expect(
      new Headers(fetcher.mock.calls[0][1].headers).has('authorization'),
    ).toBe(false);
    expect(
      new Headers(fetcher.mock.calls[1][1].headers).get('authorization'),
    ).toBe('Bearer fixture-token');
  });
  it('never retries an ambiguous run submission and retains upload identity', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () =>
        json({
          attachment: {
            id: 'upload-1',
            name: 'a.txt',
            mimeType: 'text/plain',
            size: 3,
          },
        }),
      );
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    await expect(
      client.createRun({
        sessionId: 'session-1',
        providerId: 'p',
        modelId: 'm',
        content: [{ type: 'text', text: 'Hello' }],
      }),
    ).rejects.toMatchObject({ code: 'ambiguous_run' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.uploadAttachment(
      'session-1',
      'upload-1',
      'abc',
      'a.txt',
      'text/plain',
    );
    await client.uploadAttachment(
      'session-1',
      'upload-1',
      'abc',
      'a.txt',
      'text/plain',
    );
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[2][0]);
    expect(fetcher.mock.calls[1][1].method).toBe('PUT');
    expect(
      new Headers(fetcher.mock.calls[1][1].headers).get('x-attachment-name'),
    ).toBe('a.txt');
  });
  it('retains local credentials when signout cannot confirm server revocation', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(json({ success: true }));
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    await expect(client.signOut()).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(await vault.get(origin)).toBe('fixture-token');
    await client.signOut();
    expect(await vault.get(origin)).toBeNull();
  });
});

describe('request lifecycle races', () => {
  it('signs out the original credential without revoking a concurrently replaced login', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockImplementation(async () => json({ success: true }));
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'original-token');
    const get = vault.get.bind(vault);
    vi.spyOn(vault, 'get').mockImplementationOnce(async (instance) => {
      const token = await get(instance);
      await vault.set(instance, 'replacement-token');
      return token;
    });
    await client.signOut();
    expect(
      new Headers(fetcher.mock.calls[0][1].headers).get('authorization'),
    ).toBe('Bearer original-token');
    expect(await vault.get(origin)).toBe('replacement-token');
  });
  it('does not continue an abandoned upload sequence with a replacement instance credential', async () => {
    let deliver: (response: Response) => void = () => {};
    const fetcher = vi.fn<FetchLike>(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'original-token');
    const reads = vi.spyOn(vault, 'get');
    const lifecycle = new AbortController();
    const abandonedSend = (async () => {
      // Capture the lifetime once, as the UI mutation must do before any await.
      const signal = lifecycle.signal;
      await client.uploadAttachment(
        'session-1',
        'file-1',
        'a',
        'one.txt',
        'text/plain',
        signal,
      );
      await client.uploadAttachment(
        'session-1',
        'file-2',
        'b',
        'two.txt',
        'text/plain',
        signal,
      );
      await client.createRun(
        {
          sessionId: 'session-1',
          providerId: 'provider-1',
          modelId: 'model-1',
          content: [{ type: 'text', text: 'Abandoned draft' }],
          attachmentIds: ['file-1', 'file-2'],
        },
        signal,
      );
    })().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    // The old screen is unmounted, then this origin signs in again while the
    // first request's successful server response is still in flight.
    lifecycle.abort();
    await vault.remove(origin);
    await vault.set(origin, 'replacement-token');
    deliver(
      json({
        attachment: {
          id: 'file-1',
          name: 'one.txt',
          mimeType: 'text/plain',
          size: 1,
        },
      }),
    );
    await expect(abandonedSend).resolves.toMatchObject({ code: 'cancelled' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetcher.mock.calls[0][1].headers).get('authorization'),
    ).toBe('Bearer original-token');
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(await vault.get(origin)).toBe('replacement-token');
  });
  it('aborts a stalled request and retains its credential for a retry', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<FetchLike>(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    const failure = client.apps().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(failure).resolves.toMatchObject({ code: 'request_timeout' });
    expect(await vault.get(origin)).toBe('fixture-token');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds delayed stream headers and cleans up a late response even when transport ignores abort', async () => {
    vi.useFakeTimers();
    let deliver: (response: Response) => void = () => {};
    const fetcher = vi.fn<FetchLike>(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    const failure = client
      .streamRun('run-1', {
        onEvent: vi.fn<(packet: RunStreamEvent) => void>(),
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(failure).resolves.toMatchObject({ code: 'stream_timeout' });
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    const cancel = vi.fn<() => void>();
    deliver(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await vault.get(origin)).toBe('fixture-token');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects missing interactive APIs and malformed model catalogs before entering the app', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json({ code: 'NOT_FOUND' }, 404))
      .mockResolvedValueOnce(
        json({ providers: 'invalid', defaultModel: null }),
      );
    const { client, vault } = setup(fetcher);
    await vault.set(origin, 'fixture-token');
    await expect(client.config()).rejects.toMatchObject({
      code: 'unsupported_api',
    });
    await expect(client.config()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('device login lifecycle', () => {
  it('polls while the native browser is open and stores a token only after approval', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant()))
      .mockResolvedValueOnce(json({ access_token: 'fixture-token' }));
    const { client, vault } = setup(fetcher);
    const browser = vi.fn<(url: string) => Promise<unknown>>(
      () => new Promise(() => {}),
    );
    const onCode = vi.fn<(code: DeviceCode) => void>();
    const login = new DeviceLogin(client).start({
      onCode,
      openBrowser: browser,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await login;
    expect(await vault.get(origin)).toBe('fixture-token');
    expect(browser).toHaveBeenCalledExactlyOnceWith(
      `${origin}/cli/authorize?user_code=ABCD-1234`,
    );
    expect(onCode).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: 'ABCD-1234' }),
    );
    for (const [, options] of fetcher.mock.calls) {
      expect(new Headers(options.headers).has('authorization')).toBe(false);
      expect(options.redirect).toBe('error');
    }
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({
      client_id: 'hatch-mobile',
      device_code: 'fixture-device-secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });
  it('honors slow_down without rapid retries and observes grant expiry', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant({ expires_in: 8 })))
      .mockResolvedValueOnce(json({ error: 'slow_down' }, 429))
      .mockImplementation(async () =>
        json({ error: 'authorization_pending' }, 400),
      );
    const { client, vault } = setup(fetcher);
    const login = new DeviceLogin(client).start();
    const failure = login.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(failure).resolves.toMatchObject({ code: 'expired_token' });
    expect(await vault.get(origin)).toBeNull();
  });
  it('cancels polling and ignores approval received after cancellation', async () => {
    vi.useFakeTimers();
    let approve: (value: Response) => void = () => {};
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            approve = resolve;
          }),
      );
    const { client, vault } = setup(fetcher);
    const flow = new DeviceLogin(client);
    const result = flow.start();
    const failure = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    flow.cancel();
    approve(json({ access_token: 'late-token' }));
    await expect(failure).resolves.toMatchObject({ code: 'cancelled' });
    expect(await vault.get(origin)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not leave a cancelled credential in SecureStore when a new login races its write', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant()))
      .mockResolvedValueOnce(json({ access_token: 'cancelled-token' }))
      .mockResolvedValueOnce(json(grant()))
      .mockResolvedValueOnce(json({ access_token: 'new-token' }));
    const { client, vault, storage, values } = setup(fetcher);
    storage.set.mockImplementationOnce(async (key, value) => {
      await gate;
      values.set(key, value);
    });
    const flow = new DeviceLogin(client);
    const first = flow.start().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.set).toHaveBeenCalledTimes(1);
    const second = flow.start();
    await vi.advanceTimersByTimeAsync(1000);
    release();
    await expect(first).resolves.toMatchObject({ code: 'cancelled' });
    await second;
    expect(await vault.get(origin)).toBe('new-token');
  });
  it('rolls back a cancelled sign-in while post-login instance validation is still pending', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant()))
      .mockResolvedValueOnce(
        json({ access_token: 'pending-activation-token' }),
      );
    const { client, vault } = setup(fetcher);
    const validateSession = vi.fn<(signal: AbortSignal) => Promise<void>>(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
        }),
    );
    const flow = new DeviceLogin(client);
    const pending = flow
      .start({ validateSession })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(validateSession).toHaveBeenCalledTimes(1);
    expect(await vault.get(origin)).toBe('pending-activation-token');
    flow.cancel();
    await expect(pending).resolves.toMatchObject({ code: 'cancelled' });
    expect(await vault.get(origin)).toBeNull();
  });
  it('rejects expired grants and cross-instance browser pages before opening a browser', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant({ expires_in: 0 })))
      .mockResolvedValueOnce(
        json(
          grant({
            verification_uri_complete:
              'https://evil.test/cli/authorize?user_code=ABCD-1234',
          }),
        ),
      );
    const { client } = setup(fetcher);
    const browser = vi.fn<(url: string) => Promise<unknown>>();
    const flow = new DeviceLogin(client);
    await expect(flow.start({ openBrowser: browser })).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    await expect(flow.start({ openBrowser: browser })).rejects.toMatchObject({
      code: 'invalid_verification_url',
    });
    expect(browser).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('honors overall cancellation and timeout while waiting for approval', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(grant()))
      .mockImplementation(async () =>
        json({ error: 'authorization_pending' }, 400),
      );
    const { client } = setup(fetcher);
    const result = new DeviceLogin(client).start({ timeoutMs: 2500 });
    const failure = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2500);
    await expect(failure).resolves.toMatchObject({ code: 'login_timeout' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('stream replay and recovery', () => {
  it('parses chunked UTF-8, CRLF split across chunks, comments, and multiline data', () => {
    const received: string[] = [];
    const parser = new SseParser((value) => received.push(value));
    const bytes = new TextEncoder().encode(
      ': ping\r\ndata: {"message":\r\ndata: "你好"}\r\n\r\n',
    );
    for (const byte of bytes) parser.push(new Uint8Array([byte]));
    parser.finish();
    expect(received).toEqual(['{"message":\n"你好"}']);
  });
  it('deduplicates replayed sequences and retains partial text across disconnection', async () => {
    let state = initialStreamState();
    const onEvent = (packet: RunStreamEvent) => {
      state = reduceStreamEvent(state, packet);
    };
    const first = await streamRunEvents(
      stream([event(1, { type: 'text', delta: 'Hello ' }), 'data: {"seq":2']),
      { onEvent },
    );
    expect(first).toEqual({ reason: 'disconnected', lastSeq: 1 });
    expect(state.text).toBe('Hello ');
    const second = await streamRunEvents(
      stream([
        event(1, { type: 'text', delta: 'Hello ' }),
        event(2, { type: 'text', delta: 'world' }),
        event(3, { type: 'done' }),
      ]),
      { after: state.lastSeq, onEvent },
    );
    expect(second).toEqual({ reason: 'terminal', lastSeq: 3 });
    expect(state.text).toBe('Hello world');
    expect(state.terminal).toBe('done');
    expect(
      reduceStreamEvent(state, {
        seq: 2,
        event: { type: 'text', delta: 'duplicate' },
      }),
    ).toBe(state);
  });
  it('replays from zero after process death, rather than restoring a cursor without its transcript', async () => {
    const packets = [
      event(1, { type: 'thinking', delta: 'Plan' }),
      event(2, { type: 'text', delta: 'Answer' }),
      event(3, { type: 'done' }),
    ];
    let state = initialStreamState();
    await streamRunEvents(stream(packets), {
      after: state.lastSeq,
      onEvent: (packet) => {
        state = reduceStreamEvent(state, packet);
      },
    });
    expect(state).toMatchObject({
      lastSeq: 3,
      text: 'Answer',
      thinking: 'Plan',
      terminal: 'done',
    });
  });
  it('preserves tool updates, asks, and safe environment metadata and clears prompts on terminal events', () => {
    let state = initialStreamState();
    const events: RunStreamEvent['event'][] = [
      {
        type: 'tool_start',
        id: 'tool-1',
        name: 'run_command',
        args: { command: 'pwd' },
      },
      {
        type: 'tool_update',
        id: 'tool-1',
        name: 'run_command',
        output: 'partial',
      },
      {
        type: 'tool_end',
        id: 'tool-1',
        name: 'run_command',
        isError: false,
        output: 'complete',
      },
      { type: 'ask', askId: 'ask-1', questions: [] },
      {
        type: 'env_request',
        requestId: 'env-1',
        reason: 'Configure',
        variables: [
          { key: 'API_TOKEN', description: 'Service token', secret: true },
        ],
      },
    ];
    for (const [index, value] of events.entries())
      state = reduceStreamEvent(state, { seq: index + 1, event: value });
    expect(state.tools[0]).toMatchObject({ done: true, output: 'complete' });
    expect(state.pendingAsk).toBeNull();
    expect(state.pendingEnv?.requestId).toBe('env-1');
    state = reduceStreamEvent(state, { seq: 6, event: { type: 'cancelled' } });
    expect(state).toMatchObject({
      terminal: 'cancelled',
      pendingAsk: null,
      pendingEnv: null,
    });
  });
  it('aborts an idle stream, cancels its reader, and does not cancel the server run', async () => {
    const cancelled = vi.fn<() => void>();
    const response = new Response(
      new ReadableStream<Uint8Array>({ cancel: cancelled }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const controller = new AbortController();
    const pending = streamRunEvents(response, {
      signal: controller.signal,
      onEvent: vi.fn<(packet: RunStreamEvent) => void>(),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled reader without waiting for native cancellation to resolve', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn<() => Promise<void>>(() => new Promise(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const onEvent = vi.fn<(packet: RunStreamEvent) => void>();
    const failure = streamRunEvents(response, {
      onEvent,
      idleTimeoutMs: 450,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(449);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(failure).resolves.toMatchObject({ code: 'stream_timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('resets the idle deadline on heartbeat bytes and retains the last replay cursor after a stall', async () => {
    vi.useFakeTimers();
    let enqueue: (text: string) => void = () => {};
    const cancel = vi.fn<() => void>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          enqueue = (text) =>
            controller.enqueue(new TextEncoder().encode(text));
        },
        cancel,
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    let state = initialStreamState();
    const failure = streamRunEvents(response, {
      idleTimeoutMs: 450,
      onEvent: (packet) => {
        state = reduceStreamEvent(state, packet);
      },
    }).catch((error: unknown) => error);
    enqueue(event(1, { type: 'text', delta: 'Kept text' }));
    await vi.advanceTimersByTimeAsync(200);
    enqueue(': ping\n\n');
    await vi.advanceTimersByTimeAsync(400);
    expect(cancel).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      lastSeq: 1,
      text: 'Kept text',
      terminal: null,
    });
    await vi.advanceTimersByTimeAsync(50);
    await expect(failure).resolves.toMatchObject({ code: 'stream_timeout' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.lastSeq).toBe(1);
  });
  it('aborts a pending read promptly even when transport cancellation hangs', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn<() => Promise<void>>(() => new Promise(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const controller = new AbortController();
    const failure = streamRunEvents(response, {
      signal: controller.signal,
      onEvent: vi.fn<(packet: RunStreamEvent) => void>(),
    }).catch((error: unknown) => error);
    controller.abort();
    await expect(failure).resolves.toMatchObject({ code: 'cancelled' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not skip missing sequences or accept oversized / malformed events', async () => {
    const onEvent = vi.fn<(packet: RunStreamEvent) => void>();
    await expect(
      streamRunEvents(stream([event(2, { type: 'done' })]), { onEvent }),
    ).rejects.toMatchObject({ code: 'stream_gap' });
    expect(onEvent).not.toHaveBeenCalled();
    await expect(
      streamRunEvents(
        stream(['data: {"seq":1,"event":{"type":"text","delta":5}}\n\n']),
        { onEvent },
      ),
    ).rejects.toMatchObject({ code: 'invalid_stream' });
    const parser = new SseParser(vi.fn<(data: string) => void>(), 10);
    expect(() =>
      parser.push(new TextEncoder().encode('data: ' + 'a'.repeat(20))),
    ).toThrow(MobileError);
  });
});
