// @ts-self-types="./workflow.d.ts"
import type { z } from 'zod';
import type { sourceWorkflowManifestSchema } from './workflow-schema.js';

export type WorkflowManifestInput = z.input<
  typeof sourceWorkflowManifestSchema
>;

/** Declare source configuration without executing platform operations. */
export function defineWorkflowManifest(
  manifest: WorkflowManifestInput,
): WorkflowManifestInput {
  return manifest;
}
