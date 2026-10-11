import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { appTailscaleConfigSchema } from '~/app-tailscale';
import { authMiddleware } from './auth';

export const getAppTailscaleStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { appId: string }) =>
    z.object({ appId: z.string().min(1).max(128) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { appServiceStatus } = await import('./apps/tailscale-services');
    return appServiceStatus(data.appId);
  });
export const configureAppTailscale = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input) => appTailscaleConfigSchema.parse(input))
  .handler(async ({ data }) => {
    const { saveAppService, appServiceStatus } =
      await import('./apps/tailscale-services');
    await saveAppService(data);
    return appServiceStatus(data.appId);
  });

export const listAppTailscaleStatuses = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    const { appServiceStatuses } = await import('./apps/tailscale-services');
    return appServiceStatuses();
  });
