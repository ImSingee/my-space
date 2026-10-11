import { z } from 'zod';

export const tailscaleConfigSchema = z.object({
  enabled: z.boolean(),
  hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
});

export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;

export const tailscaleDnsStatusSchema = z.object({
  magicDnsEnabled: z.boolean().nullable(),
  httpsCertificatesEnabled: z.boolean().nullable(),
});

export const tailscaleHttpsStatusSchema = z.object({
  phase: z.enum([
    'certificate',
    'certificate-delayed',
    'rate-limited',
    'listener-error',
    'ready',
  ]),
  retryAt: z.iso.datetime({ offset: true }).nullable(),
});

export type TailscaleStatus = TailscaleConfig & {
  available: boolean;
  state:
    | 'disconnected'
    | 'starting'
    | 'preparing-https'
    | 'needs-login'
    | 'needs-approval'
    | 'connected'
    | 'error';
  loginUrl: string | null;
  origin: string | null;
  message: string | null;
  dns?: z.infer<typeof tailscaleDnsStatusSchema> | null;
  https?: z.infer<typeof tailscaleHttpsStatusSchema> | null;
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
