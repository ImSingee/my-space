import { createServerFn } from '@tanstack/react-start';
import { getPlatformEnv } from '~/env';

/** Public origin only: the browser needs the runtime APP_URL, not build env. */
export const getPasskeyOrigin = createServerFn({ method: 'GET' }).handler(
  async () => getPlatformEnv().appUrl,
);
