/** Error framing and redaction across Connect's compression/decoder boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressionGzip } from '@connectrpc/connect-node';
import { ConnectError, Code } from '@connectrpc/connect';
import { errorFromJson } from '@connectrpc/connect/protocol-connect';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';

vi.mock('./auth', () => ({
  authenticatePublicApi: async () => ({ run: null }),
}));
vi.mock('~/env', () => ({
  getPlatformEnv: () => ({ appUrl: 'https://platform.test' }),
}));
vi.mock('~server/agent-runner/run-auth', () => ({
  RunTokenError: class extends Error {},
}));
vi.mock('./router', async () => {
  const { createContextKey } = await import('@connectrpc/connect');
  const { AppService } =
    await import('../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb');
  const { AppError } = await import('~server/errors');
  return {
    publicApiContext: createContextKey({ run: null }),
    registerPlatformApi: (
      router: import('@connectrpc/connect').ConnectRouter,
    ) => {
      router.rpc(AppService.method.getApp, async (request) => {
        if (request.id === 'conflict')
          throw new AppError('Public conflict. '.repeat(200), 409);
        throw new Error('fixture-private-exception');
      });
    },
  };
});
import { handlePlatformApiRequest } from './http';

const endpoint =
  'https://platform.test/api/rpc/hatch.platform.v1.AppService/GetApp';
function call(body: string, headers: Record<string, string> = {}) {
  return handlePlatformApiRequest(
    new Request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        ...headers,
      },
      body,
    }),
  );
}
afterEach(() => vi.restoreAllMocks());
describe('public RPC error transport', () => {
  it('classifies unsupported or missing content types with a public error detail', async () => {
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      undefined,
    ]) {
      const headers = new Headers({ 'connect-protocol-version': '1' });
      if (contentType) headers.set('content-type', contentType);
      const response = await handlePlatformApiRequest(
        new Request(endpoint, {
          method: 'POST',
          headers,
          body: new TextEncoder().encode('{"id":"fixture-private-input"}'),
        }),
      );
      expect(response.status).toBe(415);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(text).not.toContain('fixture-private-input');
      const error = errorFromJson(
        JSON.parse(text),
        undefined,
        new ConnectError('Invalid error'),
      );
      expect(error.code).toBe(Code.InvalidArgument);
      expect(error.findDetails(PublicErrorSchema)).toMatchObject([
        { code: 'UNSUPPORTED_MEDIA_TYPE', httpStatus: 415 },
      ]);
    }
  });
  it('preserves business errors after actual gzip compression without stale framing', async () => {
    const compressed = vi.spyOn(compressionGzip, 'compress');
    const response = await call('{"id":"conflict"}', {
      'accept-encoding': 'gzip',
    });
    expect(compressed).toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    const error = errorFromJson(
      await response.json(),
      undefined,
      new ConnectError('Invalid error'),
    );
    expect(error.code).toBe(Code.Aborted);
    expect(error.rawMessage).toBe('Public conflict. '.repeat(200));
    expect(error.findDetails(PublicErrorSchema)[0]).toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
  });
  it('returns readable decoder and internal errors without input or exception text', async () => {
    const malformed = await call('{"id":"fixture-private-input",');
    expect(malformed.status).toBe(400);
    const text = await malformed.text();
    expect(text).not.toContain('fixture-private-input');
    expect(JSON.parse(text).code).toBe('invalid_argument');
    const internal = await call('{"id":"error"}');
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain('fixture-private-exception');
  });
});
