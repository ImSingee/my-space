import { CliError } from './error';

import { platformClient } from './client';
import { authStatusSchema } from '../../../src/platform-api/auth-schemas';
import type { Profile } from './config';
export type { AuthStatus } from '../../../src/platform-api/auth-schemas';

export async function request(
  url: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    timeout: number;
    signal: AbortSignal;
  },
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: options.body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json', origin: url }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(Math.max(1, options.timeout)),
      ]),
    });
  } catch {
    if (options.signal.aborted)
      throw new CliError('cancelled', 'Cancelled.', 130);
    throw new CliError(
      'network_error',
      'The platform could not be reached (or the request timed out).',
      7,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CliError(
      'invalid_response',
      'The platform returned an invalid response.',
      7,
    );
  }
  return { response, body };
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError(
      'invalid_response',
      'The platform returned an invalid response.',
      7,
    );
  return value as Record<string, unknown>;
}

export async function getStatus(
  credential: Profile,
  timeout: number,
  signal: AbortSignal,
) {
  const value = await platformClient(credential, timeout, signal).auth.status(
    {},
  );
  const result = authStatusSchema.safeParse(value);
  if (!result.success)
    throw new CliError(
      'invalid_response',
      'The platform returned invalid authorization metadata.',
      7,
    );
  return result.data;
}
