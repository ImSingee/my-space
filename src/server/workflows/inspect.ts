/** Server-only: read-only workflow views for the Agent (list + detail). */
import { db } from '~/db';
import type { WorkflowDeploymentStatus, WorkflowStatus } from '~/db/schema';
import { type NetworkAccessView, networkAccessView } from '~/network-policy';
import {
  type WorkflowCompatibility,
  workflowCompatibility,
} from '~/workflow-compatibility';
import {
  projectWorkflowManifestUrls,
  type NormalizedWorkflowManifest,
  workflowNetworkPolicyFromManifest,
} from './manifest';
import { listWorkflowDeployments, listWorkflowRuns } from './manage';
import { listWorkflowCronJobs } from './scheduler';

export type WorkflowSummaryForAgent = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  liveVersion: number | null;
  compatibility: WorkflowCompatibility | null;
  webhook: boolean;
  cronCount: number;
};

export async function listWorkflowsForAgent(): Promise<
  WorkflowSummaryForAgent[]
> {
  const rows = await db.query.workflows.findMany({
    orderBy: { updatedAt: 'desc' },
  });
  const deploymentIds = rows
    .map((w) => w.currentDeploymentId)
    .filter((id): id is string => Boolean(id));
  const deployments =
    deploymentIds.length === 0
      ? []
      : await db.query.workflowDeployments.findMany({
          where: { id: { in: deploymentIds } },
          columns: {
            id: true,
            version: true,
            compatibilityVersion: true,
            manifestNormalized: true,
          },
        });
  const deploymentById = new Map(deployments.map((d) => [d.id, d]));
  const result: WorkflowSummaryForAgent[] = [];
  for (const w of rows) {
    let liveVersion: number | null = null;
    let compatibility: WorkflowCompatibility | null = null;
    let webhook = false;
    let cronCount = 0;
    if (w.currentDeploymentId) {
      const deployment = deploymentById.get(w.currentDeploymentId);
      liveVersion = deployment?.version ?? null;
      compatibility = deployment
        ? workflowCompatibility(deployment.compatibilityVersion)
        : null;
      const manifest =
        deployment?.manifestNormalized as NormalizedWorkflowManifest | null;
      webhook = Boolean(manifest?.triggers?.webhook?.enabled);
      cronCount = manifest?.triggers?.cron?.length ?? 0;
    }
    result.push({
      id: w.id,
      slug: w.slug,
      name: w.name,
      description: w.description,
      status: w.status,
      liveVersion,
      compatibility,
      webhook,
      cronCount,
    });
  }
  return result;
}

export type WorkflowDetailForAgent = {
  id: string;
  slug: string;
  createdAt: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  liveVersion: number | null;
  compatibility: WorkflowCompatibility | null;
  inputSchema: unknown;
  /** Declaration from the active deployment; null before first deployment. */
  network: NetworkAccessView | null;
  webhook: { enabled: boolean; url: string | null };
  cron: { name: string; schedule: string; nextRun: string | null }[];
  recentRuns: {
    id: string;
    status: string;
    trigger: string;
    createdAt: string;
  }[];
  deployments: {
    version: number;
    status: WorkflowDeploymentStatus;
    error: string | null;
    isCurrent: boolean;
    canRollback: boolean;
    compatibility: WorkflowCompatibility;
    message: string | null;
    createdAt: string;
  }[];
};

export async function getWorkflowDetailForAgent(
  id: string,
): Promise<WorkflowDetailForAgent | null> {
  const w = await db.query.workflows.findFirst({
    where: { id },
  });
  if (!w) return null;

  let liveVersion: number | null = null;
  let compatibility: WorkflowCompatibility | null = null;
  let webhook: { enabled: boolean; url: string | null } = {
    enabled: false,
    url: null,
  };
  let network: NetworkAccessView | null = null;
  if (w.currentDeploymentId) {
    const deployment = await db.query.workflowDeployments.findFirst({
      where: { id: w.currentDeploymentId as string },
    });
    liveVersion = deployment?.version ?? null;
    compatibility = deployment
      ? workflowCompatibility(deployment.compatibilityVersion)
      : null;
    const manifest =
      deployment?.manifestNormalized as NormalizedWorkflowManifest | null;
    if (deployment) {
      network = networkAccessView(
        workflowNetworkPolicyFromManifest(deployment.manifestNormalized),
      );
    }
    if (manifest?.triggers?.webhook) {
      webhook = projectWorkflowManifestUrls(manifest, id).triggers.webhook;
    }
  }

  const cron = await listWorkflowCronJobs(id);
  const runs = await listWorkflowRuns(id, 10);
  const deployments = await listWorkflowDeployments(id);

  return {
    id: w.id,
    slug: w.slug,
    createdAt: w.createdAt.toISOString(),
    name: w.name,
    description: w.description,
    status: w.status,
    liveVersion,
    compatibility,
    inputSchema: w.inputSchema ?? null,
    network,
    webhook,
    cron,
    recentRuns: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger,
      createdAt: r.createdAt,
    })),
    deployments: deployments.map((d) => ({
      version: d.version,
      status: d.status,
      error: d.error,
      isCurrent: d.isCurrent,
      canRollback: d.canRollback,
      compatibility: d.compatibility,
      message: d.message,
      createdAt: d.createdAt,
    })),
  };
}
