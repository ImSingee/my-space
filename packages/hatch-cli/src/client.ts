/** Pure contract + OpenAPI transport; never imports platform server modules. */
import {
  RequestValidationPlugin,
  ResponseValidationPlugin,
} from '@orpc/contract/plugins';
import { createORPCClient, ORPCError } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { platformApiContract } from '../../../src/platform-api/contract';
import type { Profile } from './config';
import { CliError } from './error';

export function credentialHeaders(credential: Profile): Record<string, string> {
  return credential.apiKey
    ? { 'x-api-key': credential.apiKey }
    : { authorization: `Bearer ${credential.token}` };
}
export function platformClient(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
): ContractRouterClient<typeof platformApiContract> {
  return createORPCClient(
    new OpenAPILink(platformApiContract, {
      url: `${credential.url}/api/v1`,
      headers: credentialHeaders(credential),
      plugins: [
        new RequestValidationPlugin(platformApiContract),
        new ResponseValidationPlugin(platformApiContract),
      ],
      interceptors: [
        async ({ next }) => {
          try {
            return await next();
          } catch (error) {
            const safe = publicError(error);
            let message = safe.message;
            for (const value of [credential.token, credential.apiKey])
              if (value) message = message.replaceAll(value, '[redacted]');
            throw new CliError(
              safe.code,
              message,
              safe.exitCode,
              safe.httpStatus,
            );
          }
        },
      ],
      fetch: async (input, init) => {
        try {
          return await fetch(input, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
          });
        } catch {
          throw new CliError(
            signal.aborted ? 'cancelled' : 'outcome_unknown',
            signal.aborted
              ? 'Cancelled. An in-flight mutation may still finish; inspect the platform before retrying.'
              : 'Request failed or timed out. A mutation may have finished; inspect resource/source/version before retrying.',
            signal.aborted ? 130 : 7,
          );
        }
      },
    }),
  );
}
export function publicError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ORPCError) {
    const exit =
      error.status === 401
        ? 3
        : error.status === 403
          ? 4
          : error.status === 404
            ? 5
            : error.status === 409
              ? 6
              : error.status >= 500
                ? 7
                : 2;
    const safe = error.status < 500 && error.defined;
    return new CliError(
      error.code,
      safe
        ? error.message
        : 'The platform request failed. Inspect platform state before retrying mutations.',
      exit,
      error.status,
    );
  }
  return new CliError('internal_error', 'CLI operation failed.', 1);
}
