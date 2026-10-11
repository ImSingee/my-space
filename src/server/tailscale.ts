import { createServerFn } from '@tanstack/react-start';
import { tailscaleConfigSchema, type TailscaleConfig } from '../tailscale';
import { authMiddleware } from './auth';
import { getTailscaleManager } from './tailscale-manager';

export const getTailscaleStatus = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    return getTailscaleManager().getStatus();
  });

export const configureTailscale = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: TailscaleConfig) => tailscaleConfigSchema.parse(input))
  .handler(async ({ data }) => {
    return getTailscaleManager().configure(data);
  });
