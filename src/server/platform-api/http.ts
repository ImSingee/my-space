/** Fetch transport policy; oRPC owns routing, JSON decoding and validation. */
import { ORPCError } from '@orpc/server';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { AppError } from '~server/errors';
import { RunTokenError } from '~server/agent-runner/run-auth';
import { getPlatformEnv } from '~/env';
import { publicApiErrors } from '~/platform-api/contract';
import { authenticatePublicApi, type PublicApiContext } from './auth';
import { platformApiRouter } from './router';

export const ORDINARY_BODY_LIMIT = 16 * 1024;
export const DEPLOY_BODY_LIMIT = 256 * 1024 * 1024;

function publicError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof RunTokenError) {
    return new ORPCError(
      error.code === 'invalid_token' ? 'INVALID_TOKEN' : 'RUN_ENDED',
      { status: 401 },
    );
  }
  if (error instanceof AppError && error.status < 500) {
    const code =
      (
        {
          400: 'BAD_REQUEST',
          403: 'FORBIDDEN',
          404: 'NOT_FOUND',
          409: 'CONFLICT',
          413: 'PAYLOAD_TOO_LARGE',
          415: 'UNSUPPORTED_MEDIA_TYPE',
        } as Record<number, string>
      )[error.status] ?? 'BAD_REQUEST';
    return new ORPCError(code, {
      status: error.status,
      message: error.message,
    });
  }
  if (error instanceof ORPCError) {
    // Framework validation errors may carry diagnostic data. Never return it.
    const definition =
      publicApiErrors[error.code as keyof typeof publicApiErrors];
    if (definition) return new ORPCError(error.code, definition);
  }
  return new ORPCError('INTERNAL_SERVER_ERROR');
}

function secureResponse(response: Response) {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

const handler = new OpenAPIHandler<PublicApiContext & { request: Request }>(
  platformApiRouter,
  {
    // Pull-based limit bounds actual streamed bytes, including chunked requests.
    // Limit selection is transport policy only; the oRPC contract dispatches.
    adapterInterceptors: [
      async ({ request, next, ...options }) => {
        if (!request.body) return next();
        const deploy =
          request.method === 'POST' &&
          /^\/api\/v1\/(apps|workflows)\/[^/]+\/deploy\/?$/.test(
            new URL(request.url).pathname,
          );
        const limit = deploy ? DEPLOY_BODY_LIMIT : ORDINARY_BODY_LIMIT;
        const reader = request.body.getReader();
        let size = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                return;
              }
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel();
                controller.error(new ORPCError('PAYLOAD_TOO_LARGE'));
                return;
              }
              controller.enqueue(value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return next({
          ...options,
          request: new Request(request.url, {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            body,
            duplex: 'half',
          } as RequestInit),
        });
      },
    ],
    interceptors: [
      async ({ context, next, ...options }) => {
        let authenticated: PublicApiContext;
        try {
          const request = context.request;
          // Same-origin browser access only. No CORS plugin or permissive preflight.
          const origin = request.headers.get('origin');
          if (origin && origin !== getPlatformEnv().appUrl)
            throw new ORPCError('FORBIDDEN');
          if (
            !request.headers.has('authorization') &&
            !request.headers.has('x-api-key') &&
            request.headers.get('sec-fetch-site') === 'cross-site'
          )
            throw new ORPCError('FORBIDDEN');
          if (
            request.method !== 'GET' &&
            request.headers
              .get('content-type')
              ?.split(';')[0]
              .trim()
              .toLowerCase() !== 'application/json'
          )
            throw new ORPCError('UNSUPPORTED_MEDIA_TYPE');
          authenticated = await authenticatePublicApi(request);
        } catch (error) {
          throw publicError(error);
        }
        return next({ ...options, context: { ...context, ...authenticated } });
      },
    ],
    clientInterceptors: [
      async ({ next }) => {
        try {
          return await next();
        } catch (error) {
          throw publicError(error);
        }
      },
    ],
  },
);

export async function handlePlatformApiRequest(
  request: Request,
): Promise<Response> {
  try {
    const { response } = await handler.handle(request, {
      prefix: '/api/v1',
      context: { request, run: null },
    });
    return secureResponse(
      response ??
        Response.json(new ORPCError('NOT_FOUND').toJSON(), { status: 404 }),
    );
  } catch {
    // Adapter failures also retain the documented envelope and response policy.
    return secureResponse(
      Response.json(new ORPCError('INTERNAL_SERVER_ERROR').toJSON(), {
        status: 500,
      }),
    );
  }
}
