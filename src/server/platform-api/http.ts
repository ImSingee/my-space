/** Connect owns decoding, compression, message limits and Protobuf validation. */
import { Code, ConnectError, createConnectRouter } from '@connectrpc/connect';
import { compressionGzip, compressionBrotli } from '@connectrpc/connect-node';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import {
  codeToHttpStatus,
  errorFromJson,
  errorToJson,
} from '@connectrpc/connect/protocol-connect';
import { createValidateInterceptor } from '@connectrpc/validate';
import { getPlatformEnv } from '~/env';
import { authenticatePublicApi } from './auth';
import { publicApiContext, registerPlatformApi } from './router';
import { publicApiError, publicError } from './errors';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';

export const PLATFORM_RPC_PREFIX = '/api/rpc';
export const ORDINARY_BODY_LIMIT = 16 * 1024;
export const DEPLOY_BODY_LIMIT = 256 * 1024 * 1024;

function secureResponse(response: Response) {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

const compressionAlgorithms = [compressionGzip, compressionBrotli];
const router = createConnectRouter({
  grpc: false,
  grpcWeb: false,
  requireConnectProtocolHeader: true,
  acceptCompression: compressionAlgorithms,
  readMaxBytes: ORDINARY_BODY_LIMIT,
  // Source exports and SDK responses can exceed the library's client default.
  writeMaxBytes: DEPLOY_BODY_LIMIT,
  requestGate: async (context) => {
    try {
      const headers = context.requestHeader;
      const origin = headers.get('origin');
      if (origin && origin !== getPlatformEnv().appUrl)
        throw publicApiError('FORBIDDEN');
      if (
        !headers.has('authorization') &&
        !headers.has('x-api-key') &&
        headers.get('sec-fetch-site') === 'cross-site'
      )
        throw publicApiError('FORBIDDEN');
      const auth = await authenticatePublicApi(
        new Request(context.url, { headers }),
      );
      context.values.set(publicApiContext, auth);
    } catch (error) {
      throw publicError(error);
    }
  },
  interceptors: [
    (next) => async (request) => {
      try {
        return await next(request);
      } catch (error) {
        throw publicError(error);
      }
    },
    createValidateInterceptor(),
  ],
});
registerPlatformApi(router, DEPLOY_BODY_LIMIT);
const handlers = new Map(
  router.handlers.map((handler) => [
    `${PLATFORM_RPC_PREFIX}${handler.requestPath}`,
    createFetchHandler(handler, { httpVersion: '1.1' }),
  ]),
);

export async function handlePlatformApiRequest(
  request: Request,
): Promise<Response> {
  try {
    const handler = handlers.get(new URL(request.url).pathname);
    if (!handler)
      return secureResponse(
        Response.json(errorToJson(publicApiError('NOT_FOUND'), undefined), {
          status: 404,
        }),
      );
    let response = await handler(request);
    // Protocol negotiation rejects media types before interceptors, without JSON.
    if (response.status === 415)
      return secureResponse(
        Response.json(
          errorToJson(publicApiError('UNSUPPORTED_MEDIA_TYPE'), undefined),
          { status: 415 },
        ),
      );
    // Decoder failures happen outside interceptors and may quote request values.
    if (
      response.status >= 400 &&
      response.headers.get('content-type')?.includes('application/json')
    ) {
      const encoding = response.headers.get('content-encoding');
      const compression = compressionAlgorithms.find(
        (algorithm) => algorithm.name === encoding,
      );
      const json = compression
        ? JSON.parse(
            new TextDecoder().decode(
              await compression.decompress(
                new Uint8Array(await response.arrayBuffer()),
                DEPLOY_BODY_LIMIT,
              ),
            ),
          )
        : await response.json();
      const error = errorFromJson(
        json,
        undefined,
        new ConnectError('RPC request failed.', Code.Internal),
      );
      const safe = error.findDetails(PublicErrorSchema).length
        ? error
        : error.code === Code.InvalidArgument ||
            error.code === Code.ResourceExhausted
          ? publicError(error)
          : new ConnectError('RPC request failed.', error.code);
      const headers = new Headers(response.headers);
      // Sanitization changes bytes; transport headers describe the old body.
      headers.delete('content-length');
      headers.delete('content-encoding');
      response = Response.json(errorToJson(safe, undefined), {
        status: response.status,
        headers,
      });
    }
    return secureResponse(response);
  } catch (error) {
    const safe = publicError(error);
    return secureResponse(
      Response.json(errorToJson(safe, undefined), {
        status: codeToHttpStatus(safe.code),
      }),
    );
  }
}
