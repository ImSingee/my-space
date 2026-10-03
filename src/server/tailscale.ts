import { createServerFn } from '@tanstack/react-start';
import { tailscaleConfigSchema, type TailscaleConfig } from '../tailscale';
import { authMiddleware } from './auth';

export const getTailscaleStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    const { getTailscaleManager } = await import('./tailscale-manager');
    return getTailscaleManager().getStatus();
  });

export const configureTailscale = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: TailscaleConfig) => tailscaleConfigSchema.parse(input))
  .handler(async ({ data }) => {
    const { getTailscaleManager } = await import('./tailscale-manager');
    return getTailscaleManager().configure(data);
  });
