/**
 * Shared zod building blocks for server-function validators. authMiddleware
 * only gates *who* may call an HTTP-exposed RPC and the TS parameter types
 * enforce nothing at runtime, so every payload is parsed before it reaches a
 * handler — these are the common shapes those parsers are built from.
 */
import { z } from 'zod';

export const idSchema = z.string().min(1).max(200);
export const idListSchema = z.array(idSchema).max(1000);
export const nameSchema = z.string().max(500);
export const keySchema = z.string().min(1).max(1024);
export const idAndDeploymentSchema = z.object({
  id: idSchema,
  deploymentId: idSchema,
});
export const idAndKeySchema = z.object({ id: idSchema, key: keySchema });
