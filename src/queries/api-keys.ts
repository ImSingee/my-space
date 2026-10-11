import { queryOptions } from '@tanstack/react-query';
import type {
  ApiKeySummary,
  CreatedApiKey,
  CreateApiKeyInput,
} from '~auth/api-key-contract';

async function call<T>(
  path = '',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/settings/api-keys${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Your session expired. Sign in again.'
        : 'Unable to manage API keys. Please try again.',
    );
  return response.json() as Promise<T>;
}

export const apiKeysQueryOptions = queryOptions({
  queryKey: ['auth', 'api-keys'],
  // Account-specific metadata must not survive leaving Security/signing out.
  gcTime: 0,
  retry: false,
  networkMode: 'always',
  queryFn: async ({ signal }) =>
    (await call<{ keys: ApiKeySummary[] }>('', undefined, signal)).keys,
});

/** Keep the returned secret in component memory only, never query cache. */
export const createApiKey = (input: CreateApiKeyInput) =>
  call<CreatedApiKey>('', input);
export const revokeApiKey = (id: string) =>
  call<{ success: true }>('/revoke', { id });
