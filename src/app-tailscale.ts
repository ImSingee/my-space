import { z } from 'zod';

export const appTailscaleConfigSchema = z.object({
  appId: z.string().min(1).max(128),
  serviceName: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  enabled: z.boolean(),
});
export type AppTailscaleConfig = z.infer<typeof appTailscaleConfigSchema>;
export type AppServiceAdvertisement = AppTailscaleConfig & { revision: string };
export const appServiceSnapshotSchema = z.object({
  revision: z.string().max(128),
  appId: z.string().max(128),
  serviceName: z.string().max(63),
  state: z.enum([
    'starting',
    'needs-tag',
    'pending',
    'https-pending',
    'ready',
    'error',
  ]),
  origin: z.string().max(253),
  message: z.string().max(1000),
});
export type AppServiceSnapshot = z.infer<typeof appServiceSnapshotSchema>;
export type AppTailscaleStatus = {
  config: AppTailscaleConfig | null;
  state:
    | AppServiceSnapshot['state']
    | 'disabled'
    | 'disconnected'
    | 'unavailable';
  origin: string | null;
  suffix: string | null;
  message: string | null;
};
