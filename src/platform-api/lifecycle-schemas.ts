/** Neutral source lifecycle inputs shared by public API and Runner transport. */
import { z } from 'zod';
import {
  APP_NAME_MAX_LENGTH,
  APP_SLUG_MAX_LENGTH,
  isAppNameWithinMaxLength,
} from '~/app-identity';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';

export const createAppRequestSchema = z.object({
  slug: z.string().min(1).max(APP_SLUG_MAX_LENGTH),
  name: z
    .string()
    .min(1)
    .refine(isAppNameWithinMaxLength, {
      message: `App name must be at most ${APP_NAME_MAX_LENGTH} characters.`,
    }),
  description: z.string().optional(),
  pin: z.boolean().optional(),
});

export const createWorkflowRequestSchema = z.object({
  slug: z.string().min(1).max(WORKFLOW_SLUG_MAX_LENGTH),
  name: z.string().min(1),
  description: z.string().optional(),
  pin: z.boolean().optional(),
});

export const deploySourceRequestSchema = z.object({
  message: z.string().min(1),
  allowDestructiveDataMigration: z.boolean().optional(),
  dataMigrationApprovalToken: z.string().min(1).optional(),
  /** Entity creation token observed before the caller bundled the worktree. */
  generation: z.string().min(1),
  /** Git bundle of the worktree HEAD, base64-encoded. */
  bundleBase64: z.string().min(1),
});

export const rollbackRequestSchema = z.object({
  version: z.number().int().positive(),
});
