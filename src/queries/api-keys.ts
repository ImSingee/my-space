import { queryOptions } from '@tanstack/react-query';
import type {
  ApiKeySummary,
  CreatedApiKey,
  CreateApiKeyInput,
  ApiKeyMetadata,
} from '~auth/api-key-contract';

async function call<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/auth/api-key/${path}`, {
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

function summary(key: ApiKeyMetadata): ApiKeySummary {
  return {
    id: key.id,
    name: key.name ?? '',
    prefix: key.prefix ?? '',
    start: key.start ?? '',
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastRequest: key.lastRequest,
  };
}

export const apiKeysQueryOptions = queryOptions({
  queryKey: ['auth', 'api-keys'],
  // Account-specific metadata must not survive leaving Security/signing out.
  gcTime: 0,
  retry: false,
  networkMode: 'always',
  queryFn: async ({ signal }) =>
    (
      await call<{ apiKeys: ApiKeyMetadata[] }>('list', undefined, signal)
    ).apiKeys.map(summary),
});

/** Keep the returned secret in component memory only, never query cache. */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const created = await call<ApiKeyMetadata & { key: string }>('create', {
    ...input,
    prefix: 'hatch_',
  });
  return { apiKey: summary(created), key: created.key };
}
export const revokeApiKey = (id: string) =>
  call<{ success: true }>('delete', { keyId: id });
