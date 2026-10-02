/** Shared source contract and platform deployment normalization. */
import { type NetworkPolicy, networkPolicySchema } from '~/network-policy';
import {
  sourceWorkflowManifestSchema,
  type SourceWorkflowManifest,
  type WorkflowCronJob,
} from '../../../packages/hatch-manifest/src/workflow-schema.js';
export * from '../../../packages/hatch-manifest/src/workflow-schema.js';

export type NormalizedWorkflowManifest = {
  id: string;
  name: string;
  description: string;
  entry: string;
  /** Missing only for legacy deployments, which retain unrestricted access. */
  network?: NetworkPolicy;
  triggers: {
    cron: WorkflowCronJob[];
    /** Inbound webhook URL, when the webhook trigger is enabled. */
    webhook: { enabled: boolean; url: string | null };
  };
};

/** Public inbound webhook URL (secret appended at call time as `?secret=`). */
export function workflowWebhookUrl(id: string): string {
  return `/api/workflow/${id}/run`;
}

/**
 * Project deployment-owned URLs from the authoritative workflow id at read
 * time. Stored deployment manifests are immutable and may contain legacy URLs.
 */
export function projectWorkflowManifestUrls(
  manifest: NormalizedWorkflowManifest,
  id: string,
): NormalizedWorkflowManifest {
  return {
    ...manifest,
    triggers: {
      ...manifest.triggers,
      webhook: {
        enabled: manifest.triggers.webhook.enabled,
        url: manifest.triggers.webhook.enabled ? workflowWebhookUrl(id) : null,
      },
    },
  };
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
    entry: src.entry,
    ...(src.network === undefined ? {} : { network: src.network }),
    triggers: {
      cron: src.triggers.cron,
      webhook: {
        enabled: src.triggers.webhook,
        url: src.triggers.webhook ? workflowWebhookUrl(src.id) : null,
      },
    },
  };
}

/** Read the policy from an immutable normalized deployment manifest. */
export function workflowNetworkPolicyFromManifest(
  raw: unknown,
): NetworkPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid workflow deployment manifest.');
  }
  if (!Object.hasOwn(raw, 'network')) return undefined;
  const result = networkPolicySchema.safeParse(
    (raw as Record<string, unknown>).network,
  );
  if (!result.success) {
    throw new Error(
      `Invalid workflow network policy: ${result.error.issues[0]?.message ?? 'unknown policy error'}`,
    );
  }
  return result.data;
}
