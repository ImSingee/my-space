/**
 * Workflow manifest schema + normalization.
 *
 * Dependency-light (only zod) so it can be shared by server infrastructure and
 * client UI. A workflow manifest is much smaller than an app manifest: it
 * declares the entry file, network policy, and triggers (cron + webhook). The
 * input schema is NOT in the manifest — it is derived from the workflow's zod
 * schema at build time and persisted separately.
 */
import { z } from 'zod';
import { networkPolicySchema } from './network-policy.js';
import { WORKFLOW_SLUG_MAX_LENGTH } from './workflow-identity.js';

/**
 * Reject manifest-provided paths that would escape the workflow source tree once
 * joined to it (absolute paths, Windows drive/UNC paths, or any `..` segment).
 * Kept as a pure string check so this module stays isomorphic (no `node:path`).
 */
function isUnsafeSourcePath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(p)) return true;
  return p.split(/[/\\]/).some((segment) => segment === '..');
}

/**
 * A relative path the build later joins against the workflow source dir to read
 * or bundle a file. Constrained so a malicious/mistaken manifest can't read
 * files outside the workflow checkout (e.g. `../../.env.local`).
 */
const sourceRelativePath = z
  .string()
  .min(1)
  .refine((p) => !isUnsafeSourcePath(p), {
    message:
      'must be a relative path inside the workflow source ' +
      '(no absolute or ".." paths)',
  });

/**
 * Canonical workflow-id shape: lowercase alphanumerics and hyphens, safe as a
 * path segment. A leading digit admits generated ULIDs alongside legacy kebab
 * ids. Technical boundaries use this immutable id, never the mutable slug.
 */
export const WORKFLOW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Mutable human-facing Workflow slug used in `/workflow/<slug>`. */
export const WORKFLOW_SLUG_RE = /^[a-z][a-z0-9-]*$/;

/** True when `id` is a safe Workflow id path segment (ULID or legacy kebab). */
export function isValidWorkflowId(id: string): boolean {
  return WORKFLOW_ID_RE.test(id);
}

/** True when `slug` is a valid, human-facing Workflow URL slug. */
export function isValidWorkflowSlug(slug: string): boolean {
  return slug.length <= WORKFLOW_SLUG_MAX_LENGTH && WORKFLOW_SLUG_RE.test(slug);
}

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
      WORKFLOW_ID_RE,
      'id must be lowercase letters, digits, and hyphens (a ULID or kebab id)',
    ),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Removed; retained only so legacy manifests remain parseable. */
  version: z.unknown().optional(),
  compatibilityVersion: z.number().int().min(1),
  /** Entry module exporting `defineWorkflow(...)` as default. */
  entry: sourceRelativePath.default('workflow.ts'),
  /** Missing only for legacy deployments, which retain unrestricted access. */
  network: networkPolicySchema.optional(),
  triggers: workflowTriggersSchema.default({ cron: [], webhook: false }),
});

export type SourceWorkflowManifest = z.infer<
  typeof sourceWorkflowManifestSchema
>;
