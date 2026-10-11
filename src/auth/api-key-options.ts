import type { ApiKeyConfigurationOptions } from '@better-auth/api-key';

export const apiKeyOptions = {
  requireName: true,
  maximumNameLength: 100,
  startingCharactersConfig: { charactersLength: 12 },
  storage: 'database',
  enableSessionForAPIKeys: false,
  deferUpdates: false,
  rateLimit: { enabled: false },
  keyExpiration: {
    defaultExpiresIn: null,
    minExpiresIn: 1 / 86400,
    maxExpiresIn: 3650,
  },
} satisfies ApiKeyConfigurationOptions;
