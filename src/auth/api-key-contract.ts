/** Public API key metadata. Secret material is returned only on creation. */
export const API_KEY_NAME_MAX_LENGTH = 100;
export const API_KEY_MAX_LIFETIME_DAYS = 3650;
export const API_KEY_MAX_LIFETIME_SECONDS = API_KEY_MAX_LIFETIME_DAYS * 86400;

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
