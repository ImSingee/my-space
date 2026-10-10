import { z } from 'zod';

export const tailscaleConfigSchema = z.object({
  enabled: z.boolean(),
  hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
});

export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;

export type TailscaleStatus = TailscaleConfig & {
  available: boolean;
  state:
    | 'disconnected'
    | 'starting'
    | 'needs-login'
    | 'needs-approval'
    | 'connected'
    | 'error';
  loginUrl: string | null;
  origin: string | null;
  message: string | null;
};

export const tailscaleOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'https:' &&
      !url.port &&
      /^[a-z0-9-]+\.[a-z0-9.-]+\.ts\.net$/.test(url.hostname)
    );
  } catch {
    return false;
  }
});

export const tailscaleLoginUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://login.tailscale.com' &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith('/a/')
    );
  } catch {
    return false;
  }
});
