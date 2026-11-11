/** Protect the mobile transport against the shared generated Connect contract. */
import { describe, expect, it, vi } from 'vitest';
import { createConnectRouter, ConnectError, Code } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  AgentService,
  AppService,
  PublicErrorSchema,
} from '@hatch/platform-api';
import { HatchApiClient, type FetchLike } from './client';
import { InstanceVault } from './vault';

const origin = 'https://hatch.example.test';
async function fixture() {
  const transcript = [
    { role: 'user', content: 'Hello', timestamp: 123 },
    null,
    0,
    false,
  ];
  const router = createConnectRouter({
    grpc: false,
    grpcWeb: false,
    requireConnectProtocolHeader: true,
  });
  router.service(AgentService, {
    getModelCatalog: () => ({
      providers: [
        {
          id: 'p',
          name: 'Provider',
          models: [
            {
              id: 'm',
              modelId: 'model',
              name: 'Model',
              reasoning: false,
              contextWindow: 0,
              maxTokens: 0,
            },
          ],
        },
      ],
    }),
    getSession: () => ({
      session: {
        id: 's',
        title: 'Conversation',
        updatedAt: '2026-10-16T00:00:00Z',
        serverTime: '2026-10-16T00:00:01Z',
        messages: transcript.map((value) => fromJson(ValueSchema, value)),
        activeRun: {
          id: 'r',
          status: 'blocked',
          startedAt: '2026-10-16T00:00:00Z',
          userTurn: 0,
          answeredAskId: 'ask',
          pendingAsk: {
            askId: 'ask',
            questions: [
              {
                id: 'q',
                prompt: 'Choose',
                allowMultiple: false,
                options: [{ id: 'a', label: 'A' }],
              },
            ],
          },
        },
        runs: [
          {
            id: 'r',
            status: 'blocked',
            userTurn: 0,
            startedAt: '2026-10-16T00:00:00Z',
          },
        ],
      },
    }),
    createSession: () => {
      throw new ConnectError(
        'private diagnostic and credential',
        Code.ResourceExhausted,
        undefined,
        [
          {
            desc: PublicErrorSchema,
            value: { code: 'PAYLOAD_TOO_LARGE', httpStatus: 413 },
          },
        ],
      );
    },
  });
  router.rpc(AppService.method.listApps, () => ({ resources: [] }));
  const handlers = new Map(
    router.handlers.map((handler) => [
      `/api/rpc${handler.requestPath}`,
      createFetchHandler(handler, { httpVersion: '1.1' }),
    ]),
  );
  const fetcher = vi.fn<FetchLike>((url, init) =>
    handlers.get(new URL(url).pathname)!(new Request(url, init)),
  );
  const values = new Map<string, string>();
  const vault = new InstanceVault(
    {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      remove: async (key) => {
        values.delete(key);
      },
    },
    async () => 'a'.repeat(64),
  );
  await vault.set(origin, 'session-token');
  const client = new HatchApiClient({ origin, vault, fetch: fetcher });
  return { client, fetcher, vault, transcript };
}

describe('generated Connect mobile boundary', () => {
  it('restores Protobuf defaults without inventing a default model or leaking runtime metadata', async () => {
    const { client, fetcher } = await fixture();
    expect(await client.config()).toEqual({
      providers: [
        {
          id: 'p',
          name: 'Provider',
          models: [
            {
              id: 'm',
              modelId: 'model',
              name: 'Model',
              reasoning: false,
              contextWindow: 0,
              maxTokens: 0,
            },
          ],
        },
      ],
      defaultModel: null,
    });
    expect(await client.apps()).toEqual([]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toContain('/api/rpc/hatch.platform.v1.');
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer session-token');
      expect(headers.get('connect-protocol-version')).toBe('1');
      expect(init).toMatchObject({
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        method: 'POST',
      });
    }
  });
  it('preserves transcript JSON, Retry revision and accepted-answer recovery across protobuf presence', async () => {
    const { client, transcript } = await fixture();
    const session = await client.session('s');
    expect(session.messages).toEqual(transcript);
    expect(session).toMatchObject({
      providerId: null,
      modelId: null,
      updatedAt: '2026-10-16T00:00:00Z',
      serverTime: '2026-10-16T00:00:01Z',
    });
    expect(session.activeRun).toMatchObject({
      userTurn: 0,
      answeredAskId: 'ask',
      pendingEnvRequest: null,
      pendingAsk: { questions: [{ allowMultiple: false }] },
    });
    expect(session.runs).toMatchObject([
      { userTurn: 0, completedAt: null, error: null },
    ]);
    expect(JSON.stringify(session)).not.toContain('$typeName');
  });
  it('uses PublicError logical status and never displays wire diagnostics or retries a mutation', async () => {
    const { client, fetcher, vault } = await fixture();
    const error = await client
      .createSession({ title: 'test' })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'request_failed',
      status: 413,
      message: 'This attachment or message is too large.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await vault.get(origin)).toBe('session-token');
  });
  it('rejects a pre-aborted RPC before reading credentials or sending anything', async () => {
    const { client, fetcher, vault } = await fixture();
    const get = vi.spyOn(vault, 'get');
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.createSession({}, controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
