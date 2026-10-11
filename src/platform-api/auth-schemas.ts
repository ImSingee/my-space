/** Safe authorization metadata. Secrets and raw auth/database rows stay private. */
import { z } from 'zod';
const common = {
  authenticated: z.literal(true),
  authority: z.literal('platform'),
  expiresAt: z.iso.datetime().nullable(),
};
const user = z
  .object({ id: z.string(), email: z.string(), name: z.string() })
  .strict();
export const authStatusSchema = z.discriminatedUnion('credentialType', [
  z.object({ ...common, credentialType: z.literal('session'), user }).strict(),
  z
    .object({
      ...common,
      credentialType: z.literal('api-key'),
      user,
      key: z.object({ id: z.string(), name: z.string().nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...common,
      credentialType: z.literal('run'),
      context: z
        .object({
          runId: z.string(),
          sessionId: z.string(),
          runnerId: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
export type AuthStatus = z.infer<typeof authStatusSchema>;
