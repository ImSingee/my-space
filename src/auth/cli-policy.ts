import { z } from 'zod';

export const CLI_SCOPES = [
  'app.read',
  'app.source.read',
  'app.create',
  'app.deploy',
  'app.rollback',
  'workflow.read',
  'workflow.source.read',
  'workflow.create',
  'workflow.deploy',
  'workflow.rollback',
] as const;
export type CliScope = (typeof CLI_SCOPES)[number];
export type CredentialType = 'interactive_key' | 'user_api_key' | 'run_key';

export const resourceRangeSchema = z.union([
  z.object({ mode: z.literal('all') }).strict(),
  z
    .object({
      mode: z.literal('ids'),
      apps: z.array(z.string().min(1)).max(100),
      workflows: z.array(z.string().min(1)).max(100),
    })
    .strict(),
]);
export type ResourceRange = z.infer<typeof resourceRangeSchema>;
export const scopesSchema = z
  .array(z.enum(CLI_SCOPES))
  .min(1)
  .max(CLI_SCOPES.length)
  .refine(
    (values) => new Set(values).size === values.length,
    'Duplicate scope',
  );
export const grantSchema = z
  .object({
    scopes: scopesSchema,
    resources: resourceRangeSchema.default({
      mode: 'ids',
      apps: [],
      workflows: [],
    }),
  })
  .strict()
  .refine(
    ({ scopes, resources }) =>
      resources.mode === 'all' ||
      !scopes.some((scope) => scope.endsWith('.create')),
    'Create requires an explicit all-resource grant',
  );
export const keyRequestSchema = grantSchema.safeExtend({
  name: z.string().trim().min(1).max(64),
  expiresIn: z
    .number()
    .int()
    .min(300)
    .max(90 * 86400),
});
export const deviceRequestSchema = grantSchema.safeExtend({
  client_id: z.literal('hatch-cli'),
  expiresIn: z
    .number()
    .int()
    .min(300)
    .max(30 * 86400)
    .default(7 * 86400),
});

export function permissionsFor(
  scopes: readonly CliScope[],
): Record<string, string[]> {
  return { hatch: [...scopes] };
}
export function scopesFrom(permissions: unknown): CliScope[] {
  const parsed = z
    .object({ hatch: scopesSchema })
    .strict()
    .safeParse(permissions);
  return parsed.success ? parsed.data.hatch : [];
}

/** All public plugin entry points are sealed; only Hatch's reviewed routes issue keys. */
export function isSealedAuthPath(pathname: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(pathname).replace(/\/+$/, '');
  } catch {
    return true;
  }
  return /^\/api\/auth\/(?:api-key(?:\/|$)|device(?:\/|$))/.test(path);
}

export function issuanceEnabled(): boolean {
  return process.env.HATCH_CLI_AUTH_ENABLED === 'true';
}
