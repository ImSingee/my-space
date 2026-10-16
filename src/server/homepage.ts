import { createServerFn } from '@tanstack/react-start';
import { homepageTargetSchema, type HomepageTarget } from '~/homepage';
import { authMiddleware, requireSession } from './auth';
import {
  homepageDestination,
  listHomepageApps,
  readHomepage,
  saveHomepage,
} from './homepage-store';

export type HomepageSettings = {
  userId: string;
  homepage: HomepageTarget;
  available: boolean;
  apps: { id: string; name: string }[];
};

export const getHomepageSettings = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<HomepageSettings> => {
    const { user } = await requireSession();
    const homepage = await readHomepage(user.id);
    const { available } = await homepageDestination(homepage);
    return {
      userId: user.id,
      homepage,
      available,
      apps: await listHomepageApps(),
    };
  });

export const updateHomepageSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: HomepageTarget) => homepageTargetSchema.parse(input))
  .handler(async ({ data }): Promise<HomepageSettings> => {
    const { user } = await requireSession();
    const homepage = await saveHomepage(user.id, data);
    return {
      userId: user.id,
      homepage,
      available: true,
      apps: await listHomepageApps(),
    };
  });

/** Read fresh on every entry so other browsers' changes take effect. */
export const getHomepageDestination = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<string> => {
    const { user } = await requireSession();
    return (await homepageDestination(await readHomepage(user.id))).href;
  });
