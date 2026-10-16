import { queryOptions } from '@tanstack/react-query';
import { getHomepageSettings } from '~server/homepage';

export const homepageSettingsQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'homepage'],
    queryFn: async () => {
      const settings = await getHomepageSettings();
      if (settings.userId !== userId)
        throw new Error('Your account changed. Reload the page to continue.');
      return settings;
    },
  });
