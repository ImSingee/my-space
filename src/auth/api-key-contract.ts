import type { ApiKey } from '@better-auth/api-key';

/** UI metadata. The native API returns the full record without secret material. */
export const API_KEY_NAME_MAX_LENGTH = 100;
export const API_KEY_MAX_LIFETIME_DAYS = 3650;

/** Fields consumed from the native plugin's JSON responses. */
export type ApiKeyMetadata = Pick<
  ApiKey,
  'id' | 'name' | 'prefix' | 'start'
> & {
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
};

export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  start: string;
  createdAt: string;
  expiresAt: string | null;
  lastRequest: string | null;
};

export type CreateApiKeyInput = {
  name: string;
  /** Lifetime in seconds, or null for no expiry; 1 second to 10 years. */
  expiresIn: number | null;
};

export type CreatedApiKey = { apiKey: ApiKeySummary; key: string };
