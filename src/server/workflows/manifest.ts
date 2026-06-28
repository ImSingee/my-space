/**
 * Workflow manifest schema + normalization.
 *
 * Dependency-light (only zod) so it can be shared by server infrastructure and
 * client UI. A workflow manifest is much smaller than an app manifest: it
 * declares the entry file and the triggers (cron + webhook). The input schema
 * is NOT in the manifest — it is derived from the workflow's zod schema at build
 * time and persisted separately.
 */
import { z } from 'zod';

/** JSON-serializable value mirror (kept local to avoid importing the db here). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const workflowCronSchema = z.object({
  name: z.string().min(1),
  /** Standard 5-field cron expression: minute hour day-of-month month day-of-week. */
  schedule: z.string().min(1),
  /**
   * Fixed input passed to the workflow on each scheduled run. Validated against
   * the workflow input schema like any other trigger. Defaults to `{}`.
   */
  input: z.record(z.string(), z.unknown()).default({}),
});

export type WorkflowCronJob = z.infer<typeof workflowCronSchema>;

export const workflowTriggersSchema = z.object({
  cron: z.array(workflowCronSchema).default([]),
  /** Whether a public, secret-protected inbound webhook can start runs. */
  webhook: z.boolean().default(false),
});

export const sourceWorkflowManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'id must be kebab-case (lowercase letters, digits, hyphens)',
    ),
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.number().int().min(1).default(1),
  /** Entry module exporting `defineWorkflow(...)` as default. */
  entry: z.string().min(1).default('workflow.ts'),
  triggers: workflowTriggersSchema.default({ cron: [], webhook: false }),
});

export type SourceWorkflowManifest = z.infer<
  typeof sourceWorkflowManifestSchema
>;

export type NormalizedWorkflowManifest = {
  id: string;
  name: string;
  description: string;
  version: number;
  entry: string;
  triggers: {
    cron: WorkflowCronJob[];
    /** Inbound webhook URL, when the webhook trigger is enabled. */
    webhook: { enabled: boolean; url: string | null };
  };
};

/** Public inbound webhook URL (secret appended at call time as `?secret=`). */
export function workflowWebhookUrl(id: string): string {
  return `/api/workflow-hooks/${id}`;
}

/** Parse + validate raw manifest JSON authored by the Agent. */
export function parseSourceWorkflowManifest(
  raw: unknown,
): SourceWorkflowManifest {
  return sourceWorkflowManifestSchema.parse(raw);
}

/** Produce the deploy-time manifest with concrete platform URLs. */
export function normalizeWorkflowManifest(
  src: SourceWorkflowManifest,
): NormalizedWorkflowManifest {
  return {
    id: src.id,
    name: src.name,
    description: src.description,
    version: src.version,
    entry: src.entry,
    triggers: {
      cron: src.triggers.cron,
      webhook: {
        enabled: src.triggers.webhook,
        url: src.triggers.webhook ? workflowWebhookUrl(src.id) : null,
      },
    },
  };
}
