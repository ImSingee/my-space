import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { AppError } from '~server/errors';
import { RunTokenError } from '~server/agent-runner/run-auth';

const definitions = {
  BAD_REQUEST: [Code.InvalidArgument, 400, 'Invalid request.'],
  UNAUTHORIZED: [Code.Unauthenticated, 401, 'Authentication required.'],
  INVALID_TOKEN: [Code.Unauthenticated, 401, 'Invalid Run credential.'],
  RUN_ENDED: [Code.Unauthenticated, 401, 'Run is no longer live.'],
  FORBIDDEN: [Code.PermissionDenied, 403, 'Cross-origin request denied.'],
  NOT_FOUND: [Code.NotFound, 404, 'Resource not found.'],
  CONFLICT: [Code.Aborted, 409, 'Resource conflict.'],
  RESOURCE_GENERATION_CONFLICT: [
    Code.Aborted,
    409,
    'Resource was deleted or recreated. Fetch its current source.',
  ],
  PAYLOAD_TOO_LARGE: [Code.ResourceExhausted, 413, 'Payload too large.'],
  UNSUPPORTED_MEDIA_TYPE: [
    Code.InvalidArgument,
    415,
    'Unsupported content type.',
  ],
  INTERNAL_SERVER_ERROR: [Code.Internal, 500, 'Internal server error.'],
  SERVICE_UNAVAILABLE: [Code.Unavailable, 503, 'Service unavailable.'],
} as const;
export type PublicErrorCode = keyof typeof definitions;

export function publicApiError(code: PublicErrorCode, message?: string) {
  const [connectCode, httpStatus, fallback] = definitions[code];
  return new ConnectError(message ?? fallback, connectCode, undefined, [
    {
      desc: PublicErrorSchema,
      value: create(PublicErrorSchema, { code, httpStatus }),
    },
  ]);
}

/** Preserve declared business errors, never exception text or decoded input. */
export function publicError(error: unknown): ConnectError {
  if (error instanceof RunTokenError)
    return publicApiError(
      error.code === 'invalid_token' ? 'INVALID_TOKEN' : 'RUN_ENDED',
    );
  if (error instanceof AppError && error.status < 500) {
    const codes: Record<number, PublicErrorCode> = {
      400: 'BAD_REQUEST',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
    };
    return publicApiError(codes[error.status] ?? 'BAD_REQUEST', error.message);
  }
  if (error instanceof ConnectError) {
    if (error.findDetails(PublicErrorSchema).length) return error;
    // Protovalidate's details contain field paths and rules, not input values.
    if (error.code === Code.InvalidArgument) {
      const safe = publicApiError('BAD_REQUEST');
      safe.details.push(...error.details);
      return safe;
    }
    if (error.code === Code.ResourceExhausted)
      return publicApiError('PAYLOAD_TOO_LARGE');
    if (error.code === Code.Canceled || error.code === Code.DeadlineExceeded)
      return error;
  }
  return publicApiError('INTERNAL_SERVER_ERROR');
}
