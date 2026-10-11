import { queryOptions } from '@tanstack/react-query';
import { authClient } from '~auth/client';

export type ApiKey = NonNullable<
  Awaited<ReturnType<typeof authClient.apiKey.list>>['data']
>['apiKeys'][number];
export type CreatedApiKey = NonNullable<
  Awaited<ReturnType<typeof authClient.apiKey.create>>['data']
>;
export type CreateApiKeyInput = Parameters<typeof authClient.apiKey.create>[0];

const fetchOptions = { cache: 'no-store', retry: 0 } as const;

function requireData<T>(result: {
  data: T | null;
  error: { status: number } | null;
}): T {
  if (result.error || !result.data)
    throw new Error(
      result.error?.status === 401
        ? 'Your session expired. Sign in again.'
        : 'Unable to manage API keys. Please try again.',
    );
  return result.data;
}

export const apiKeysQueryOptions = queryOptions({
  queryKey: ['auth', 'api-keys'],
  // Account-specific metadata must not survive leaving Security/signing out.
  gcTime: 0,
  retry: false,
  networkMode: 'always',
  queryFn: async ({ signal }) =>
    requireData(
      await authClient.apiKey.list({
        fetchOptions: { ...fetchOptions, signal },
      }),
    ).apiKeys,
});

/** Keep the returned secret in component memory only, never query cache. */
export async function createApiKey(input: CreateApiKeyInput) {
  return requireData(
    await authClient.apiKey.create({
      ...input,
      prefix: 'hatch_',
      fetchOptions,
    }),
  );
}
export async function revokeApiKey(id: string) {
  return requireData(
    await authClient.apiKey.delete({ keyId: id, fetchOptions }),
  );
}
