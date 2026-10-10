// @ts-self-types="./manifest.d.ts"
import type { z } from 'zod';
import type { sourceWorkflowManifestSchema } from '../../../packages/hatch-manifest/src/workflow-schema.js';

export type WorkflowManifestInput = z.input<
  typeof sourceWorkflowManifestSchema
>;

/** Declare source configuration without executing platform operations. */
export function defineWorkflowManifest(
  manifest: WorkflowManifestInput,
): WorkflowManifestInput {
  return manifest;
}
